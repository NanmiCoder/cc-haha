import { useEffect, useState } from 'react'
import { Copy, LogIn, LogOut } from 'lucide-react'
import { useHahaGrokOAuthStore } from '../../stores/hahaGrokOAuthStore'
import { useTranslation } from '../../i18n'
import { copyTextToClipboard } from '../chat/clipboard'
import { getDesktopHost } from '../../lib/desktopHost'
import { hahaGrokOAuthApi } from '../../api/hahaGrokOAuth'

export function GrokOfficialLogin() {
  const t = useTranslation()
  const [manualAuthorizeUrl, setManualAuthorizeUrl] = useState<string | null>(null)
  const [isAwaitingAuthorization, setIsAwaitingAuthorization] = useState(false)
  const { status, isLoading, error, fetchStatus, login, logout, startPolling, stopPolling } =
    useHahaGrokOAuthStore()

  useEffect(() => {
    void fetchStatus()
    return () => stopPolling()
  }, [fetchStatus, stopPolling])

  useEffect(() => {
    if (status?.loggedIn) setManualAuthorizeUrl(null)
  }, [status?.loggedIn])

  useEffect(() => {
    if (!status?.loggedIn || !isAwaitingAuthorization) return
    setIsAwaitingAuthorization(false)
    void getDesktopHost().shell.open(hahaGrokOAuthApi.successUrl()).catch((err) => {
      console.error('[GrokOfficialLogin] success page open failed:', err)
    })
  }, [isAwaitingAuthorization, status?.loggedIn])

  const handleLogin = async () => {
    setManualAuthorizeUrl(null)
    try {
      const { authorizeUrl } = await login()
      setManualAuthorizeUrl(authorizeUrl)
      try {
        await getDesktopHost().shell.open(authorizeUrl)
        setManualAuthorizeUrl(null)
        setIsAwaitingAuthorization(true)
        startPolling()
      } catch (err) {
        console.error('[GrokOfficialLogin] shellOpen failed:', err)
        useHahaGrokOAuthStore.setState({
          error: t('settings.grokOfficialLogin.openBrowserFailed'),
        })
      }
    } catch {
      // Store owns request errors.
    }
  }

  const handleCopyAuthorizeUrl = async () => {
    if (!manualAuthorizeUrl) return
    if (await copyTextToClipboard(manualAuthorizeUrl)) {
      setManualAuthorizeUrl(null)
      setIsAwaitingAuthorization(true)
      useHahaGrokOAuthStore.setState({ error: null })
      startPolling()
    } else {
      useHahaGrokOAuthStore.setState({
        error: t('settings.grokOfficialLogin.copyLinkFailed'),
      })
    }
  }

  const manualAuthorizeButton = manualAuthorizeUrl ? (
    <button
      type="button"
      onClick={handleCopyAuthorizeUrl}
      className="inline-flex items-center gap-1.5 self-start rounded-md border border-[var(--color-border-separator)] bg-[var(--color-surface)] px-3 py-1.5 text-xs transition-colors hover:bg-[var(--color-surface-hover)]"
    >
      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      {t('settings.grokOfficialLogin.copyAuthorizeUrl')}
    </button>
  ) : null

  if (status === null) {
    return (
      <div data-testid="grok-official-login" className="flex flex-col gap-2 text-xs">
        {error ? (
          <div className="text-[var(--color-error)]">{t('settings.grokOfficialLogin.errorPrefix')}{error}</div>
        ) : (
          <div className="text-[var(--color-text-tertiary)]">{t('common.loading')}</div>
        )}
        {manualAuthorizeButton}
      </div>
    )
  }

  if (status.loggedIn) {
    return (
      <div data-testid="grok-official-login" className="flex items-center gap-3 text-sm">
        <span className="text-[var(--color-success)]">
          {t('settings.grokOfficialLogin.loggedInPrefix')} {status.email || t('settings.grokOfficialLogin.accountUnknown')}
        </span>
        <button
          type="button"
          onClick={logout}
          disabled={isLoading}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-separator)] bg-[var(--color-surface)] px-3 py-1 text-xs transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
        >
          <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
          {isLoading ? t('settings.grokOfficialLogin.logoutProcessing') : t('settings.grokOfficialLogin.logoutButton')}
        </button>
      </div>
    )
  }

  return (
    <div data-testid="grok-official-login" className="flex flex-col gap-2">
      <div className="text-sm text-[var(--color-text-secondary)]">{t('settings.grokOfficialLogin.intro')}</div>
      <button
        type="button"
        onClick={handleLogin}
        disabled={isLoading}
        className="inline-flex items-center gap-2 self-start rounded-md bg-[image:var(--gradient-btn-primary)] px-4 py-2 text-sm text-[var(--color-btn-primary-fg)] shadow-[var(--shadow-button-primary)] transition-opacity hover:brightness-105 disabled:opacity-50"
      >
        <LogIn className="h-4 w-4" aria-hidden="true" />
        {isLoading ? t('settings.grokOfficialLogin.loginStarting') : t('settings.grokOfficialLogin.loginButton')}
      </button>
      {error && <div className="text-xs text-[var(--color-error)]">{t('settings.grokOfficialLogin.errorPrefix')}{error}</div>}
      {manualAuthorizeButton}
    </div>
  )
}
