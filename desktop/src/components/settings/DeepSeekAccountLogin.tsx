import { useEffect, useState } from 'react'
import { CircleCheck, Copy, LogIn, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useHahaDeepSeekOAuthStore } from '../../stores/hahaDeepSeekOAuthStore'
import { useTranslation } from '../../i18n'
import { copyTextToClipboard } from '@/lib/clipboard'
import { getDesktopHost } from '../../lib/desktopHost'
import { OfficialLoginRiskDialog } from './OfficialLoginRiskDialog'

export function DeepSeekAccountLogin() {
  const t = useTranslation()
  const [manualAuthorizeUrl, setManualAuthorizeUrl] = useState<string | null>(null)
  const [riskDialogOpen, setRiskDialogOpen] = useState(false)
  const { status, isLoading, error, fetchStatus, login, logout, startPolling, stopPolling } =
    useHahaDeepSeekOAuthStore()

  useEffect(() => {
    void fetchStatus()
    return () => stopPolling()
  }, [fetchStatus, stopPolling])

  useEffect(() => {
    if (status?.loggedIn) setManualAuthorizeUrl(null)
  }, [status?.loggedIn])

  const handleLogin = async () => {
    setManualAuthorizeUrl(null)
    try {
      const { authorizeUrl } = await login()
      setManualAuthorizeUrl(authorizeUrl)
      try {
        await getDesktopHost().shell.open(authorizeUrl)
        setManualAuthorizeUrl(null)
        startPolling()
      } catch (err) {
        console.error('[DeepSeekAccountLogin] shellOpen failed:', err)
        useHahaDeepSeekOAuthStore.setState({
          error: t('settings.deepseekAccountLogin.openBrowserFailed'),
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
      useHahaDeepSeekOAuthStore.setState({ error: null })
      startPolling()
    } else {
      useHahaDeepSeekOAuthStore.setState({
        error: t('settings.deepseekAccountLogin.copyLinkFailed'),
      })
    }
  }

  const manualAuthorizeButton = manualAuthorizeUrl ? (
    <Button
      variant="secondary"
      size="sm"
      onClick={handleCopyAuthorizeUrl}
      icon={<Copy className="h-3.5 w-3.5" aria-hidden="true" />}
      className="self-start"
    >
      {t('settings.deepseekAccountLogin.copyAuthorizeUrl')}
    </Button>
  ) : null

  if (status === null) {
    return (
      <div data-testid="deepseek-account-login" className="flex flex-col gap-2 text-xs">
        {error ? (
          <div className="text-[var(--color-error)]">{t('settings.deepseekAccountLogin.errorPrefix')}{error}</div>
        ) : (
          <div className="text-[var(--color-text-tertiary)]">{t('common.loading')}</div>
        )}
        {manualAuthorizeButton}
      </div>
    )
  }

  if (status.loggedIn) {
    const account = [status.name, status.contact].filter(Boolean).join(' · ')
    return (
      <div data-testid="deepseek-account-login" className="flex flex-wrap items-center gap-3 text-[13px]">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[var(--color-success)]">
          <CircleCheck size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
          {t('settings.deepseekAccountLogin.loggedInPrefix')} {account || t('settings.deepseekAccountLogin.accountUnknown')}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={logout}
          disabled={isLoading}
          icon={<LogOut className="h-3.5 w-3.5" aria-hidden="true" />}
        >
          {isLoading ? t('settings.deepseekAccountLogin.logoutProcessing') : t('settings.deepseekAccountLogin.logoutButton')}
        </Button>
      </div>
    )
  }

  return (
    <div data-testid="deepseek-account-login" className="flex flex-col gap-2">
      <div className="text-[13px] leading-5 text-[var(--color-text-secondary)]">{t('settings.deepseekAccountLogin.intro')}</div>
      <Button
        size="base"
        onClick={() => setRiskDialogOpen(true)}
        disabled={isLoading}
        icon={<LogIn size={14} strokeWidth={1.75} aria-hidden="true" />}
        className="self-start"
      >
        {isLoading ? t('settings.deepseekAccountLogin.loginStarting') : t('settings.deepseekAccountLogin.loginButton')}
      </Button>
      {error && <div className="text-xs text-[var(--color-error)]">{t('settings.deepseekAccountLogin.errorPrefix')}{error}</div>}
      {manualAuthorizeButton}
      <OfficialLoginRiskDialog
        open={riskDialogOpen}
        provider="deepseek"
        onClose={() => setRiskDialogOpen(false)}
        onConfirm={() => {
          setRiskDialogOpen(false)
          void handleLogin()
        }}
      />
    </div>
  )
}
