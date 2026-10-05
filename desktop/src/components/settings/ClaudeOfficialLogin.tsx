// desktop/src/components/settings/ClaudeOfficialLogin.tsx
//
// 显示当前 Claude Official OAuth 登录状态,提供 Login / Logout 按钮。
// 点击 Login 调 desktop host shell.open 打开浏览器走 OAuth flow;浏览器回 callback
// 到 haha server 后,store 的 polling 自动刷新 UI 展示"已登录"。

import { useEffect } from 'react'
import { CircleCheck } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useHahaOAuthStore } from '../../stores/hahaOAuthStore'
import { useTranslation } from '../../i18n'
import { getDesktopHost } from '../../lib/desktopHost'

export function ClaudeOfficialLogin() {
  const t = useTranslation()
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
      <Button size="base" onClick={handleLogin} disabled={isLoading} className="self-start">
        {isLoading
          ? t('settings.claudeOfficialLogin.loginStarting')
          : t('settings.claudeOfficialLogin.loginButton')}
      </Button>
      {error && (
        <div className="text-xs text-[var(--color-error)]">
          {t('settings.claudeOfficialLogin.errorPrefix')}{error}
        </div>
      )}
    </div>
  )
}
