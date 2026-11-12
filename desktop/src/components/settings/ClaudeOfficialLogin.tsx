// desktop/src/components/settings/ClaudeOfficialLogin.tsx
//
// Shows the current Claude Official OAuth login state with Login / Logout buttons.
// Login calls the desktop host shell.open to run the OAuth flow in a browser; once the
// browser calls back to the haha server, the store's polling refreshes the UI to "logged in".

import { useEffect, useState } from 'react'
import { CircleCheck } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useHahaOAuthStore } from '../../stores/hahaOAuthStore'
import { useTranslation } from '../../i18n'
import { getDesktopHost } from '../../lib/desktopHost'
import { OfficialLoginRiskDialog } from './OfficialLoginRiskDialog'

export function ClaudeOfficialLogin() {
  const t = useTranslation()
  const [riskDialogOpen, setRiskDialogOpen] = useState(false)
  const {
    status,
    isLoading,
    error,
    fetchStatus,
    login,
    logout,
    startPolling,
    stopPolling,
  } = useHahaOAuthStore()

  useEffect(() => {
    fetchStatus()
    return () => stopPolling()
  }, [fetchStatus, stopPolling])

  const handleLogin = async () => {
    try {
      const { authorizeUrl } = await login()
      try {
        await getDesktopHost().shell.open(authorizeUrl)
        startPolling()
      } catch (err) {
        console.error('[ClaudeOfficialLogin] shellOpen failed:', err)
        useHahaOAuthStore.setState({
          error: t('settings.claudeOfficialLogin.openBrowserFailed'),
        })
      }
    } catch {
      // store.login() errors are already captured into store.error
    }
  }

  if (status === null) {
    if (error) {
      return (
        <div className="text-xs text-[var(--color-error)]">
          {t('settings.claudeOfficialLogin.errorPrefix')}{error}
        </div>
      )
    }
    return (
      <div className="text-xs text-[var(--color-text-tertiary)]">
        {t('common.loading')}
      </div>
    )
  }

  if (status.loggedIn) {
    const subTypeLabel = status.subscriptionType
      ? status.subscriptionType.toUpperCase()
      : t('settings.claudeOfficialLogin.subTypeUnknown')
    return (
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <span className="inline-flex items-center gap-1.5 text-[var(--color-success)]">
          <CircleCheck size={14} strokeWidth={1.75} aria-hidden="true" />
          {t('settings.claudeOfficialLogin.loggedInPrefix')} {subTypeLabel})
        </span>
        <Button variant="secondary" size="sm" onClick={logout} disabled={isLoading}>
          {isLoading
            ? t('settings.claudeOfficialLogin.logoutProcessing')
            : t('settings.claudeOfficialLogin.logoutButton')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[13px] leading-5 text-[var(--color-text-secondary)]">
        {t('settings.claudeOfficialLogin.intro')}
      </div>
      <Button
        size="base"
        onClick={() => setRiskDialogOpen(true)}
        disabled={isLoading}
        className="self-start"
      >
        {isLoading
          ? t('settings.claudeOfficialLogin.loginStarting')
          : t('settings.claudeOfficialLogin.loginButton')}
      </Button>
      {error && (
        <div className="text-xs text-[var(--color-error)]">
          {t('settings.claudeOfficialLogin.errorPrefix')}{error}
        </div>
      )}
      <OfficialLoginRiskDialog
        open={riskDialogOpen}
        provider="claude"
        onClose={() => setRiskDialogOpen(false)}
        onConfirm={() => {
          setRiskDialogOpen(false)
          void handleLogin()
        }}
      />
    </div>
  )
}
