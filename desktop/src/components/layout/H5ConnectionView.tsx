import type { FormEvent } from 'react'
import { useState } from 'react'
import { readStoredH5Connection, saveAndVerifyH5Connection } from '../../lib/desktopRuntime'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { BrandSeal } from '@/components/composite/BrandSeal'
import { useTranslation } from '../../i18n'

type H5ConnectionViewProps = {
  initialServerUrl?: string | null
  error?: string | null
  onConnected: () => void
}

export function H5ConnectionView({
  initialServerUrl,
  error: initialError,
  onConnected,
}: H5ConnectionViewProps) {
  const t = useTranslation()
  const [serverUrl, setServerUrl] = useState(initialServerUrl ?? '')
  const [token, setToken] = useState('')
  const [error, setError] = useState(initialError ?? '')
  const [submitting, setSubmitting] = useState(false)
  const remembered = readStoredH5Connection()
  const canRetry = remembered.token && remembered.serverUrl === serverUrl.trim().replace(/\/$/, '')

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')

    try {
      await saveAndVerifyH5Connection(serverUrl, token)
      onConnected()
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : t('h5Connect.failed'),
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="animate-screen-pop h-screen flex items-center justify-center bg-[var(--color-surface)] px-6">
      <Card
        as="section"
        radius="xl"
        surface="low"
        padding="lg"
        shadow="card"
        className="w-full max-w-md"
      >
        <div className="mb-5 flex flex-col items-center gap-3 text-center">
          <BrandSeal size="lg" />
          <h1
            className="text-[21px] font-semibold tracking-tight text-[var(--color-text-primary)]"
            style={{ fontFamily: 'var(--font-headline)' }}
          >
            {t('h5Connect.title')}
          </h1>
          <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
            {t('h5Connect.subtitle')}
          </p>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <Input
            label={t('h5Connect.serverUrl')}
            placeholder="https://chat.example.com"
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
            autoComplete="url"
            required
          />
          <Input
            label={t('h5Connect.token')}
            type="password"
            placeholder="h5_..."
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="current-password"
            required
          />

          {error ? (
            <div
              role="alert"
              className="rounded-[var(--radius-md)] border border-[var(--color-error)] bg-[var(--color-error-container)] px-3 py-2 text-sm text-[var(--color-on-error-container)]"
            >
              {error}
            </div>
          ) : null}

          <Button type="submit" size="lg" className="w-full" loading={submitting}>
            {t('h5Connect.submit')}
          </Button>
          {canRetry && <Button type="button" variant="secondary" className="w-full" disabled={submitting} onClick={async () => {
            setSubmitting(true)
            setError('')
            try {
              await saveAndVerifyH5Connection(serverUrl, remembered.token!)
              onConnected()
            } catch (retryError) {
              setError(retryError instanceof Error ? retryError.message : t('h5Connect.failed'))
            } finally { setSubmitting(false) }
          }}>{t('common.retry')}</Button>}
        </form>
      </Card>
    </div>
  )
}
