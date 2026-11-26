import { useEffect, useId, useState } from 'react'
import { MonitorSmartphone, RefreshCw } from 'lucide-react'
import { computerUseApi } from '@/api/computerUse'
import { ModelBrandIcon } from '@/components/composite/ModelBrandIcon'
import { PermissionModeSelector } from '@/components/controls/PermissionModeSelector'
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
} from '@/components/settings/SettingsSection'
import { Badge, StatusDot, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import {
  ANTIGRAVITY_ACP_LOGIN_COMMAND,
  ANTIGRAVITY_ACP_PERMISSION_MODES,
  ANTIGRAVITY_ACP_PROVIDER_ID,
} from '@/constants/antigravityAcp'
import { useTranslation } from '@/i18n'
import { useProviderStore } from '@/stores/providerStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import type { AntigravityStatusState } from '@/types/provider'

const STATUS_BADGE_TONE: Record<AntigravityStatusState, Tone> = {
  ready: 'success',
  login_required: 'warning',
  error: 'danger',
  unchecked: 'neutral',
  not_installed: 'neutral',
}

export function AntigravityProviderCard({ browserMode = false }: { browserMode?: boolean }) {
  const t = useTranslation()
  const titleId = useId()
  const statusId = useId()
  const antigravity = useProviderStore((state) => state.antigravity)
  const antigravityEnabled = useProviderStore((state) => state.antigravityEnabled)
  const discover = useProviderStore((state) => state.discoverAntigravity)
  const setAntigravityEnabled = useProviderStore((state) => state.setAntigravityEnabled)
  const permissionMode = useSettingsStore((state) => state.permissionMode)
  const setPermissionMode = useSettingsStore((state) => state.setPermissionMode)
  const setActiveSettingsTab = useUIStore((state) => state.setActiveSettingsTab)
  const [checking, setChecking] = useState(false)
  const [failed, setFailed] = useState(false)
  const [computerUseEnabled, setComputerUseEnabled] = useState<boolean | null>(null)

  const isInstalled = Boolean(antigravity && antigravity.status !== 'not_installed')

  useEffect(() => {
    if (!antigravity || browserMode) return
    let active = true
    void computerUseApi.getAuthorizedApps()
      .then((config) => {
        if (active) setComputerUseEnabled(config.enabled === true)
      })
      .catch(() => {
        if (active) setComputerUseEnabled(null)
      })
    return () => {
      active = false
    }
  }, [antigravity, browserMode])

  if (!antigravity) return null

  const status: AntigravityStatusState = failed ? 'error' : antigravity.status
  const tone = STATUS_BADGE_TONE[status]

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

  const statusText = status === 'ready' && antigravity.models.length > 0
    ? t('settings.providers.antigravity.status.readyWithModels', { count: antigravity.models.length })
    : t(`settings.providers.antigravity.status.${status}`, { command: ANTIGRAVITY_ACP_LOGIN_COMMAND })

  const computerUseDescription = computerUseEnabled === true
    ? t('settings.providers.antigravity.computerUseActive')
    : computerUseEnabled === false
      ? t('settings.providers.antigravity.computerUseInactive')
      : t('settings.providers.antigravity.computerUseNote')

  return (
    <SettingsSection
      title={t('settings.providers.localRuntimes.title')}
      description={t('settings.providers.localRuntimes.description')}
    >
      <SettingsGroup aria-labelledby={titleId} data-testid="antigravity-provider-card">
        <SettingsRow
          titleId={titleId}
          title={(
            <div className="flex flex-wrap items-center gap-2">
              <ModelBrandIcon
                providerId={ANTIGRAVITY_ACP_PROVIDER_ID}
                size={15}
                className="text-[var(--color-text-secondary)]"
              />
              <span>{t('settings.providers.antigravity.name')}</span>
              <Badge
                tone={tone}
                icon={status === 'ready' || status === 'login_required' || status === 'error'
                  ? <StatusDot tone={tone} />
                  : undefined}
              >
                {t(`settings.providers.antigravity.badge.${status}`)}
              </Badge>
              {antigravity.version ? (
                <Badge tone="neutral">
                  <span className="font-mono text-[11px]">{antigravity.version}</span>
                </Badge>
              ) : null}
              {antigravity.tier?.name ? (
                <Badge tone="info">{antigravity.tier.name}</Badge>
              ) : null}
            </div>
          )}
          description={t('settings.providers.antigravity.description')}
          footer={(
            <div className="space-y-1.5">
              <p
                id={statusId}
                role={status === 'error' ? 'alert' : 'status'}
                className={`text-xs leading-[1.5] ${
                  status === 'error'
                    ? 'text-[var(--color-error)]'
                    : status === 'login_required'
                      ? 'text-[var(--color-on-warning-container)]'
                      : 'text-[var(--color-text-secondary)]'
                }`}
              >
                {statusText}
              </p>
              {status === 'login_required' ? (
                <div className="inline-flex items-center rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-2.5 py-1 font-mono text-xs text-[var(--color-text-primary)]">
                  {ANTIGRAVITY_ACP_LOGIN_COMMAND}
                </div>
              ) : null}
            </div>
          )}
        >
          <Button
            variant="secondary"
            size="sm"
            loading={checking}
            onClick={checkConnection}
            aria-describedby={statusId}
            icon={<RefreshCw size={13} strokeWidth={1.75} aria-hidden="true" />}
          >
            {t('settings.providers.antigravity.check')}
          </Button>
        </SettingsRow>

        <SettingsSwitchRow
          title={t('settings.providers.antigravity.enableLabel')}
          description={t('settings.providers.antigravity.enableDesc')}
          checked={antigravityEnabled && isInstalled}
          disabled={!isInstalled}
          onChange={setAntigravityEnabled}
          data-testid="antigravity-enable-row"
        />

        <SettingsRow
          title={t('settings.providers.antigravity.defaultPermissionTitle')}
          description={t('settings.providers.antigravity.defaultPermissionDesc')}
          data-testid="antigravity-default-permission-row"
        >
          <PermissionModeSelector
            antigravity
            allowedModes={ANTIGRAVITY_ACP_PERMISSION_MODES}
            value={permissionMode}
            onChange={(mode) => void setPermissionMode(mode)}
            workDir={t('settings.general.defaultPermissionScope')}
            menuPlacement="bottom"
            menuAlign="right"
          />
        </SettingsRow>

        <SettingsRow
          title={(
            <span className="inline-flex items-center gap-1.5">
              <MonitorSmartphone size={14} strokeWidth={1.75} aria-hidden="true" className="text-[var(--color-text-tertiary)]" />
              <span>{t('settings.providers.antigravity.computerUseTitle')}</span>
              {computerUseEnabled !== null ? (
                <Badge tone={computerUseEnabled ? 'success' : 'neutral'}>
                  {t(computerUseEnabled
                    ? 'settings.providers.antigravity.computerUseBadgeOn'
                    : 'settings.providers.antigravity.computerUseBadgeOff')}
                </Badge>
              ) : null}
            </span>
          )}
          description={computerUseDescription}
          layout="inline"
          data-testid="antigravity-computer-use-row"
        >
          {!browserMode ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setActiveSettingsTab('computerUse')}
            >
              {t('settings.providers.antigravity.openComputerUseSettings')}
            </Button>
          ) : null}
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  )
}
