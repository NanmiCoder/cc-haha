import { useEffect, useRef, useState } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle, Loader2 } from 'lucide-react'

import type {
  LspDiagnostic,
  LspUnavailableReason,
  LegacyWorkspaceLspState,
} from '../../types/lsp'

/**
 * Status indicator for the editor's LSP backend (Phase 3 task 25).
 *
 * Surfaces four states with contextual icons and labels:
 *   - ready (CheckCircle, "Ready" or "N errors detected")
 *   - starting (Loader2 spin, "Starting language server…")
 *   - unavailable / prereq-missing (AlertTriangle, "Install...")
 *   - unavailable / other reasons (AlertCircle, "Retry")
 *
 * The dropdown lists diagnostics grouped by file, with messages truncated
 * at 200 chars. Empty list shows "No diagnostics". Keyboard a11y:
 *   - Tab focuses the trigger
 *   - Enter / Space opens the dropdown
 *   - Arrow Up/Down rotate through entries
 *   - Enter activates a focused entry (caller decides what "open" means)
 *   - Esc closes the dropdown
 *
 * The aria-live="polite" mirror gives screen readers a textual update on
 * state transitions without spamming announcements during quick changes.
 *
 * _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9, 13.10_
 */

const ERROR_COUNT_DISPLAY_CAP = 9999
const DIAGNOSTIC_MESSAGE_TRUNCATE_AT = 200

export type LspStatusIndicatorProps = {
  state: LegacyWorkspaceLspState
  diagnostics: LspDiagnostic[]
  /** Called for prereq-missing — host opens PluginPrerequisitesModal. */
  onInstallClick?: () => void
  /** Called for any other unavailable reason — host triggers a retry. */
  onRetryClick?: () => void
  /** Called when the user activates a diagnostic entry. */
  onDiagnosticOpen?: (diagnostic: LspDiagnostic) => void
}

type StatusVisual = {
  Icon: typeof CheckCircle | typeof AlertCircle | typeof Loader2 | typeof AlertTriangle
  label: string
  className: string
  /** 'install' | 'retry' | null */
  action: 'install' | 'retry' | null
}

function describeUnavailable(reason: LspUnavailableReason): StatusVisual {
  if (reason === 'prereq-missing') {
    return {
      Icon: AlertTriangle,
      label: 'Language server unavailable',
      className: 'text-[var(--color-warning-text)]',
      action: 'install',
    }
  }
  return {
    Icon: AlertCircle,
    label: 'Language server unavailable',
    className: 'text-[var(--color-error-text)]',
    action: 'retry',
  }
}

function describe(state: LegacyWorkspaceLspState): StatusVisual {
  if (state.state === 'starting') {
    return {
      Icon: Loader2,
      label: 'Starting language server…',
      className: 'text-[var(--color-text-muted)] animate-spin',
      action: null,
    }
  }
  if (state.state === 'ready') {
    if (state.errorCount === 0) {
      return {
        Icon: CheckCircle,
        label: 'Ready',
        className: 'text-[var(--color-success-text)]',
        action: null,
      }
    }
    const display = state.errorCount > ERROR_COUNT_DISPLAY_CAP
      ? `${ERROR_COUNT_DISPLAY_CAP}+ errors detected`
      : `${state.errorCount} ${state.errorCount === 1 ? 'error' : 'errors'} detected`
    return {
      Icon: AlertCircle,
      label: display,
      className: 'text-[var(--color-error-text)]',
      action: null,
    }
  }
  return describeUnavailable(state.reason)
}

function truncateMessage(message: string): string {
  if (message.length <= DIAGNOSTIC_MESSAGE_TRUNCATE_AT) return message
  return `${message.slice(0, DIAGNOSTIC_MESSAGE_TRUNCATE_AT - 1)}…`
}

export function LspStatusIndicator(props: LspStatusIndicatorProps) {
  const { state, diagnostics, onInstallClick, onRetryClick, onDiagnosticOpen } = props
  const [open, setOpen] = useState(false)
  const [focusIndex, setFocusIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const visual = describe(state)

  useEffect(() => {
    if (!open) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        setFocusIndex((i) => Math.min(diagnostics.length - 1, i + 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setFocusIndex((i) => Math.max(0, i - 1))
      } else if (event.key === 'Enter' || event.key === ' ') {
        const target = diagnostics[focusIndex]
        if (target) {
          event.preventDefault()
          onDiagnosticOpen?.(target)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, diagnostics, focusIndex, onDiagnosticOpen])

  return (
    <div className="relative inline-flex items-center gap-2 text-[12px]" data-testid="lsp-status-indicator">
      <button
        ref={triggerRef}
        type="button"
        data-testid="lsp-status-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen(true)
            setFocusIndex(0)
          }
        }}
        className="inline-flex items-center gap-1.5 rounded-[6px] border border-[var(--color-border)] px-2 py-0.5 hover:bg-[var(--color-surface-hover)]"
      >
        <visual.Icon size={14} className={visual.className} aria-hidden="true" />
        <span data-testid="lsp-status-label">{visual.label}</span>
      </button>

      {visual.action === 'install' && (
        <button
          type="button"
          data-testid="lsp-status-install"
          onClick={onInstallClick}
          className="rounded-[6px] border border-[var(--color-border)] px-2 py-0.5 hover:bg-[var(--color-surface-hover)]"
        >
          Install...
        </button>
      )}
      {visual.action === 'retry' && (
        <button
          type="button"
          data-testid="lsp-status-retry"
          onClick={onRetryClick}
          className="rounded-[6px] border border-[var(--color-border)] px-2 py-0.5 hover:bg-[var(--color-surface-hover)]"
        >
          Retry
        </button>
      )}

      {/* aria-live mirror for screen readers — visible labels above are
       *  decorative-grade; this sr-only region announces transitions. */}
      <span aria-live="polite" className="sr-only" data-testid="lsp-status-sr">
        {visual.label}
      </span>

      {open && (
        <div
          role="listbox"
          aria-label="LSP diagnostics"
          data-testid="lsp-status-dropdown"
          className="absolute left-0 top-full z-30 mt-1 w-[420px] rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface)] p-2 shadow-[var(--shadow-dropdown)]"
        >
          {diagnostics.length === 0 ? (
            <div data-testid="lsp-status-empty" className="px-2 py-1 text-[var(--color-text-muted)]">
              No diagnostics
            </div>
          ) : (
            <ul className="space-y-1">
              {diagnostics.map((diagnostic, index) => (
                <li key={`${diagnostic.path}:${diagnostic.line}:${diagnostic.column}:${index}`}>
                  <button
                    type="button"
                    role="option"
                    data-testid="lsp-status-diagnostic"
                    aria-selected={focusIndex === index}
                    onClick={() => onDiagnosticOpen?.(diagnostic)}
                    onFocus={() => setFocusIndex(index)}
                    className={`w-full rounded-[6px] px-2 py-1 text-left ${
                      focusIndex === index ? 'bg-[var(--color-surface-hover)]' : ''
                    }`}
                  >
                    <div className="text-[var(--color-text)]">
                      {diagnostic.path}:{diagnostic.line}:{diagnostic.column}
                    </div>
                    <div className="text-[11px] text-[var(--color-text-muted)]">
                      {diagnostic.severity} — {truncateMessage(diagnostic.message)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
