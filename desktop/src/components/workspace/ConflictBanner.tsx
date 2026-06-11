import { useEffect, useState } from 'react'
import type { WorkspaceBufferConflict } from '../../stores/workspacePanelStore'

/**
 * Banner shown over the editor when the file's on-disk content has changed
 * since the buffer was opened (Phase 2 — only `source: 'user'` events
 * trigger this; agent-source rendering ships in PR-4).
 *
 * Two layouts driven by `isDirty`:
 *  - clean buffer: single `Reload` button + the actor/timestamp tail.
 *  - dirty buffer: three buttons — `Reload (discard my changes)`,
 *    `Keep mine`, `Open conflict view`.
 *
 * Renders ≤ 200 ms (it's a static element with no async loading); shows the
 * workspace-relative path, hash first 8 hex, and a relative timestamp that
 * refreshes every 60 s.
 *
 * _Requirements: 3.2, 3.3, 3.4, 3.5 (Phase 2 task 13)_
 */

const TIMESTAMP_REFRESH_MS = 60_000

export type ConflictBannerProps = {
  filePath: string
  isDirty: boolean
  conflict: WorkspaceBufferConflict
  onReload: () => void
  onKeepMine: () => void
  onOpenConflictView: () => void
}

function shortHash(hash: string): string {
  return hash.length >= 8 ? hash.slice(0, 8) : hash
}

function formatRelativeTime(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

export function ConflictBanner(props: ConflictBannerProps) {
  const { filePath, isDirty, conflict, onReload, onKeepMine, onOpenConflictView } = props

  // Re-render every 60 s so the relative timestamp ticks forward without
  // the editor having to dispatch its own ticker.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), TIMESTAMP_REFRESH_MS)
    return () => clearInterval(handle)
  }, [])

  const actorLabel =
    conflict.source === 'agent'
      ? `agent${conflict.actor ? ` (${conflict.actor})` : ''}`
      : 'another window'

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="workspace-conflict-banner"
      className="border-b border-[var(--color-warning-border)] bg-[var(--color-warning-surface)] px-3 py-2 text-[12px] text-[var(--color-warning-text)]"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">
          {filePath} was changed by {actorLabel}
        </span>
        <span className="text-[var(--color-text-muted)]">
          hash {shortHash(conflict.hash)} · {formatRelativeTime(conflict.timestamp, now)}
        </span>

        <div className="ml-auto flex gap-2">
          {isDirty ? (
            <>
              <button
                type="button"
                data-testid="conflict-reload"
                onClick={onReload}
                className="rounded-[6px] border border-[var(--color-warning-border)] px-2.5 py-1 hover:bg-[var(--color-warning-hover)]"
              >
                Reload (discard my changes)
              </button>
              <button
                type="button"
                data-testid="conflict-keep-mine"
                onClick={onKeepMine}
                className="rounded-[6px] border border-[var(--color-warning-border)] px-2.5 py-1 hover:bg-[var(--color-warning-hover)]"
              >
                Keep mine
              </button>
              <button
                type="button"
                data-testid="conflict-open-view"
                onClick={onOpenConflictView}
                className="rounded-[6px] border border-[var(--color-warning-border)] px-2.5 py-1 hover:bg-[var(--color-warning-hover)]"
              >
                Open conflict view
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid="conflict-reload"
              onClick={onReload}
              className="rounded-[6px] border border-[var(--color-warning-border)] px-2.5 py-1 hover:bg-[var(--color-warning-hover)]"
            >
              Reload
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
