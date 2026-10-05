import { Copy, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from '../../i18n'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { DoctorPanel } from '../doctor/DoctorPanel'
import { copyTextToClipboard } from '@/lib/clipboard'

const LOG_MARKER = '\n\nRecent server logs:\n'

export function splitStartupError(error: string) {
  const markerIndex = error.indexOf(LOG_MARKER)
  if (markerIndex === -1) {
    return {
      message: error,
      logs: '',
      diagnostics: error,
    }
  }

  const message = error.slice(0, markerIndex).trim()
  const logs = error.slice(markerIndex + LOG_MARKER.length).trim()
  return {
    message,
    logs,
    diagnostics: `${message}\n\nRecent server logs:\n${logs}`,
  }
}

type StartupErrorViewProps = {
  error: string
}

export function StartupErrorView({ error }: StartupErrorViewProps) {
  const t = useTranslation()
  const { message, logs, diagnostics } = useMemo(() => splitStartupError(error), [error])
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    const ok = await copyTextToClipboard(diagnostics)
    if (!ok) return

    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="animate-screen-pop h-screen flex items-center justify-center bg-[var(--color-surface)] px-6">
      <Card
        as="section"
        radius="xl"
        surface="lowest"
        padding="lg"
        shadow="card"
        className="w-full max-w-3xl"
      >
        <div className="flex flex-col gap-4">
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight text-[var(--color-text-primary)]">
              {t('app.serverFailed')}
            </h1>
            <p className="mt-1.5 text-[13px] leading-6 text-[var(--color-text-tertiary)]">
              {t('app.serverFailedHint')}
            </p>
          </div>

          <Card radius="md" surface="none" padding="sm" className="bg-[var(--color-code-bg)]">
            <div className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">
              {t('app.startupError')}
            </div>
            <pre className="mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.65] text-[var(--color-error)]">
              {message}
            </pre>
          </Card>

          {logs ? (
            <Card radius="md" surface="none" padding="sm" className="bg-[var(--color-code-bg)]">
              <div className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">
                {t('app.serverLogs')}
              </div>
              <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.65] text-[var(--color-text-secondary)]">
                {logs}
              </pre>
            </Card>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              icon={<Copy size={14} strokeWidth={1.75} aria-hidden="true" />}
              onClick={handleCopy}
            >
              {copied ? t('app.copiedDiagnostics') : t('app.copyDiagnostics')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon={<RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />}
              onClick={() => window.location.reload()}
            >
              {t('common.retry')}
            </Button>
          </div>

          <DoctorPanel compact />
        </div>
      </Card>
    </div>
  )
}
