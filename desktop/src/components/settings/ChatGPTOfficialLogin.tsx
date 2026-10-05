// desktop/src/components/settings/ChatGPTOfficialLogin.tsx

import { useEffect, useState } from 'react'
import { CircleCheck, Copy, LogIn, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useHahaOpenAIOAuthStore } from '../../stores/hahaOpenAIOAuthStore'
import { useTranslation } from '../../i18n'
import { copyTextToClipboard } from '@/lib/clipboard'
import { getDesktopHost } from '../../lib/desktopHost'

export function ChatGPTOfficialLogin() {
  const t = useTranslation()
  const [manualAuthorizeUrl, setManualAuthorizeUrl] = useState<string | null>(null)
  const {
    status,
    isLoading,
    error,
    fetchStatus,
    login,
    logout,
    startPolling,
    stopPolling,
  } = useHahaOpenAIOAuthStore()

  useEffect(() => {
    void fetchStatus()
    return () => stopPolling()
  }, [fetchStatus, stopPolling])

  useEffect(() => {
    if (status?.loggedIn) {
      setManualAuthorizeUrl(null)
    }
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
        console.error('[ChatGPTOfficialLogin] shellOpen failed:', err)
        useHahaOpenAIOAuthStore.setState({
          error: t('settings.chatgptOfficialLogin.openBrowserFailed'),
        })
      }
    } catch {
      // store.login() errors are already captured into store.error
    }
  }

  const handleCopyAuthorizeUrl = async () => {
    if (!manualAuthorizeUrl) return
    const copied = await copyTextToClipboard(manualAuthorizeUrl)
    if (copied) {
      setManualAuthorizeUrl(null)
      useHahaOpenAIOAuthStore.setState({ error: null })
      startPolling()
      return
    }
    useHahaOpenAIOAuthStore.setState({
      error: t('settings.chatgptOfficialLogin.copyLinkFailed'),
    })
  }

  const manualAuthorizeButton = manualAuthorizeUrl ? (
    <Button
      variant="secondary"
      size="sm"
      onClick={handleCopyAuthorizeUrl}
      icon={<Copy className="h-3.5 w-3.5" aria-hidden="true" />}
      className="self-start"
    >
      {t('settings.chatgptOfficialLogin.copyAuthorizeUrl')}
    </Button>
  ) : null

  if (status === null) {
    if (error) {
      return (
        <div data-testid="chatgpt-official-login" className="flex flex-col gap-2">
          <div className="text-xs text-[var(--color-error)]">
            {t('settings.chatgptOfficialLogin.errorPrefix')}{error}
          </div>
          {manualAuthorizeButton}
        </div>
      )
    }
    return (
      <div data-testid="chatgpt-official-login" className="text-xs text-[var(--color-text-tertiary)]">
        {t('common.loading')}
      </div>
    )
  }

  if (status.loggedIn) {
    const accountLabel = status.email || status.accountId || t('settings.chatgptOfficialLogin.accountUnknown')
    return (
      <div data-testid="chatgpt-official-login" className="flex flex-wrap items-center gap-3 text-[13px]">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[var(--color-success)]">
          <CircleCheck size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
          {t('settings.chatgptOfficialLogin.loggedInPrefix')} {accountLabel}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={logout}
          disabled={isLoading}
          icon={<LogOut className="h-3.5 w-3.5" aria-hidden="true" />}
        >
          {isLoading
            ? t('settings.chatgptOfficialLogin.logoutProcessing')
            : t('settings.chatgptOfficialLogin.logoutButton')}
        </Button>
      </div>
    )
  }

  return (
    <div data-testid="chatgpt-official-login" className="flex flex-col gap-2">
      <div className="text-[13px] leading-5 text-[var(--color-text-secondary)]">
        {t('settings.chatgptOfficialLogin.intro')}
      </div>
      <Button
        size="base"
        onClick={handleLogin}
        disabled={isLoading}
        icon={<LogIn size={14} strokeWidth={1.75} aria-hidden="true" />}
        className="self-start"
      >
        {isLoading
          ? t('settings.chatgptOfficialLogin.loginStarting')
          : t('settings.chatgptOfficialLogin.loginButton')}
      </Button>
      {error && (
        <div className="text-xs text-[var(--color-error)]">
          {t('settings.chatgptOfficialLogin.errorPrefix')}{error}
        </div>
      )}
      {manualAuthorizeButton}
    </div>
  )
}
