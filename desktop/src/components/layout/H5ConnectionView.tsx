import type { FormEvent } from 'react'
import { useState } from 'react'
import { saveAndVerifyH5Connection } from '../../lib/desktopRuntime'
import { Button } from '../shared/Button'
import { Input } from '../shared/Input'

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
  const [serverUrl, setServerUrl] = useState(initialServerUrl ?? '')
  const [token, setToken] = useState('')
  const [error, setError] = useState(initialError ?? '')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')

    try {
      await saveAndVerifyH5Connection(serverUrl, token)
      onConnected()
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : 'Unable to connect to the H5 server.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="h-screen flex items-center justify-center bg-[var(--color-surface)] px-6">
      <section className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-6 shadow-[var(--shadow-md)]">
        <div className="mb-5">
          <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">
            Connect to H5 Access
          </h1>
          <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
            Enter the server URL and H5 access token from the desktop app.
          </p>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <Input
            label="Server URL"
            placeholder="https://chat.example.com"
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
            autoComplete="url"
            required
          />
          <Input
            label="H5 Token"
            type="password"
            placeholder="h5_..."
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="current-password"
            required
          />

          {error ? (
            <div className="rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/8 px-3 py-2 text-sm text-[var(--color-error)]">
              {error}
            </div>
          ) : null}

          <Button type="submit" size="lg" className="w-full" loading={submitting}>
            Connect
          </Button>
        </form>
      </section>
    </div>
  )
}
