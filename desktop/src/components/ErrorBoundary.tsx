import React from 'react'
import { t } from '../i18n'
import { reportReactError } from '../lib/diagnosticsCapture'
import { Button } from './shared/Button'
import { DoctorPanel } from './doctor/DoctorPanel'

type Props = {
  children: React.ReactNode
}

type State = {
  hasError: boolean
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: unknown, errorInfo: React.ErrorInfo) {
    void reportReactError(error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return <ErrorBoundaryFallback />
    }

    return this.props.children
  }
}

function ErrorBoundaryFallback() {
  return (
    <div className="h-screen w-screen bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center">
        <div className="text-base font-semibold">{t('errorBoundary.title')}</div>
        <div className="mt-2 text-sm text-[var(--color-text-tertiary)]">
          {t('errorBoundary.description')}
        </div>
        <div className="mt-4 flex justify-center">
          <Button type="button" variant="secondary" size="sm" onClick={() => window.location.reload()}>
            {t('common.retry')}
          </Button>
        </div>
        <div className="mt-4 text-left">
          <DoctorPanel compact />
        </div>
      </div>
    </div>
  )
}
