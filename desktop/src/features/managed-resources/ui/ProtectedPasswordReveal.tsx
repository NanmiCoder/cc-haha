import { useEffect, useRef, useState } from 'react'
import { Eye, EyeOff, ShieldCheck } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import { getDesktopHost } from '../../../lib/desktopHost'

export type ProtectedPasswordRevealProps = {
  credentialId: string
  label?: string
  compact?: boolean
}

type RevealedState = {
  password: string
  expiresAt: number
}

function errorFallback(code: string): string {
  switch (code) {
    case 'OS_AUTH_CANCELLED': return 'Windows verification was cancelled.'
    case 'OS_AUTH_FAILED': return 'The Windows password was not accepted.'
    case 'OS_AUTH_UNAVAILABLE': return 'Windows password verification is unavailable.'
    case 'CREDENTIAL_NOT_PASSWORD': return 'This credential is not a revealable password.'
    default: return 'Unable to reveal the saved password.'
  }
}

export function ProtectedPasswordReveal({ credentialId, label, compact = false }: ProtectedPasswordRevealProps) {
  const t = useTranslation()
  const [revealed, setRevealed] = useState<RevealedState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearReveal = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    setRevealed(null)
  }

  useEffect(() => {
    clearReveal()
    setError(null)
    return clearReveal
    // A credential id change must immediately evict the old plaintext.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentialId])

  const reveal = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    clearReveal()
    try {
      const result = await getDesktopHost().hostManagement.revealCredential(credentialId)
      if (!result.ok) {
        const translated = t(result.error.messageKey as never)
        setError(translated && translated !== result.error.messageKey ? translated : errorFallback(result.error.code))
        return
      }
      const expiresAt = result.data.expiresAt
      setRevealed({ password: result.data.password, expiresAt })
      const remaining = Math.max(0, expiresAt - Date.now())
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        setRevealed(null)
      }, remaining)
    } catch {
      setError(errorFallback('OS_AUTH_UNAVAILABLE'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={compact
        ? 'inline-flex min-w-0 items-center gap-2 text-[11px]'
        : 'flex min-w-0 flex-col gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container)] p-3 text-xs'}
      data-testid={`protected-password-${credentialId}`}
    >
      {!compact && (
        <div className="flex items-center gap-2 font-medium text-[var(--color-text-secondary)]">
          <ShieldCheck size={14} className="text-[var(--color-brand)]" />
          <span>{label || t('managedResources.passwordReveal.label' as never) || 'Saved password'}</span>
        </div>
      )}
      <div className="flex min-w-0 items-center gap-2">
        <code
          data-testid={`protected-password-value-${credentialId}`}
          className="max-w-[22rem] truncate rounded bg-[var(--color-surface)] px-2 py-1 font-mono text-[var(--color-text-primary)]"
        >
          {revealed ? revealed.password : '••••••••'}
        </code>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
          disabled={busy}
          onClick={() => revealed ? clearReveal() : void reveal()}
          aria-label={revealed
            ? (t('managedResources.passwordReveal.hide' as never) || 'Hide password')
            : (t('managedResources.passwordReveal.reveal' as never) || 'Verify and reveal')}
        >
          {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
          <span>{busy
            ? (t('managedResources.passwordReveal.verifying' as never) || 'Verifying Windows account…')
            : revealed
              ? (t('managedResources.passwordReveal.hide' as never) || 'Hide')
              : (t('managedResources.passwordReveal.reveal' as never) || 'Verify & reveal')}</span>
        </button>
      </div>
      {!compact && (
        <div className="text-[10px] text-[var(--color-text-tertiary)]">
          {revealed
            ? (t('managedResources.passwordReveal.expires' as never) || 'Automatically hides after 15 seconds.')
            : (t('managedResources.passwordReveal.hint' as never) || 'Enter the current Windows account password. The saved password is shown for 15 seconds only.')}
        </div>
      )}
      {error && <div role="alert" className="text-[10px] text-[var(--color-error)]">{error}</div>}
    </div>
  )
}
