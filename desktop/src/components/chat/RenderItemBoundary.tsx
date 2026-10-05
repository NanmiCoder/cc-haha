import React from 'react'
import { TriangleAlert } from 'lucide-react'
import { t } from '../../i18n'
import { reportReactError } from '../../lib/diagnosticsCapture'

type Props = {
  children: React.ReactNode
}

type State = {
  failed: boolean
}

/**
 * Keeps one transcript item that fails to render from taking the whole app with it.
 *
 * The root ErrorBoundary replaces everything, and a transcript is rebuilt from saved
 * history — so a single bad record (issue #1400: an AskUserQuestion input the model
 * got wrong) crashed the app again on every launch, because the open tab is restored.
 * Here the failure stays in its row: the rest of the conversation, the sidebar and the
 * composer keep working, and the error still goes to Diagnostics.
 *
 * There is deliberately no automatic retry. A stored record fails the same way every
 * time, and retrying on each render would report it on every update of a live list.
 * The row is tried again whenever it is mounted afresh (switching session, reloading).
 */
export class RenderItemBoundary extends React.Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: unknown, errorInfo: React.ErrorInfo) {
    void reportReactError(error, errorInfo)
  }

  render() {
    if (!this.state.failed) return this.props.children

    return (
      <div className="mb-3 flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2 text-xs text-[var(--color-text-tertiary)]">
        <TriangleAlert aria-hidden size={14} strokeWidth={1.75} className="shrink-0" />
        <span>{t('errorBoundary.item')}</span>
      </div>
    )
  }
}
