import { useId, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ANTIGRAVITY_ACP_LOGIN_COMMAND } from '@/constants/antigravityAcp'
import { useTranslation } from '@/i18n'
import { useProviderStore } from '@/stores/providerStore'

export function AntigravityProviderCard() {
  const t = useTranslation()
  const titleId = useId()
  const statusId = useId()
  const localAgent = useProviderStore((state) => state.localAgent)
  const discover = useProviderStore((state) => state.discoverAntigravity)
  const [checking, setChecking] = useState(false)
  const [failed, setFailed] = useState(false)
  if (!localAgent) return null

  const checkConnection = async () => {
    setChecking(true)
    setFailed(false)
    try {
      await discover()
    } catch {
      setFailed(true)
    } finally {
      setChecking(false)
    }
  }
  const status = failed ? 'error' : localAgent.status

  return (
    <Card as="section" aria-labelledby={titleId} className="mt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id={titleId} className="text-[13px] font-semibold text-[var(--color-text-primary)]">
            {t('settings.providers.antigravity.name')}
          </h2>
          <p className="text-xs text-[var(--color-text-secondary)]">{t('settings.providers.antigravity.description')}</p>
          <p id={statusId} role={status === 'error' ? 'alert' : 'status'} className="text-xs text-[var(--color-text-secondary)]">
            {t(`settings.providers.antigravity.status.${status}`, { command: ANTIGRAVITY_ACP_LOGIN_COMMAND })}
            {localAgent.version ? ` · ${localAgent.version}` : null}
          </p>
        </div>
        <Button variant="secondary" size="sm" loading={checking} onClick={checkConnection} aria-describedby={statusId}>
          {t('settings.providers.antigravity.check')}
        </Button>
      </div>
    </Card>
  )
}
