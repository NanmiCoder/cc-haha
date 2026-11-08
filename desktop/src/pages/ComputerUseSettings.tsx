import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import {
  CircleAlert,
  CircleCheck,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react'
import { computerUseApi, type ComputerUseStatus } from '../api/computerUse'
import { useTranslation } from '../i18n'
import { ComputerUseEnableDialog } from '@/components/computer-use/ComputerUseEnableDialog'
import { COMPUTER_USE_ENABLE_REQUEST, needsComputerUsePermissionCard } from '@/lib/computerUseEnable'
import {
  SettingsBlock,
  SettingsGroup,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsSection'
import { Badge, StatusDot, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
import { Switch } from '@/components/ui/Switch'

type CheckState = 'loading' | 'ready' | 'error'
// Settings.tsx owns the page frame (width, gutters); a pane is just a column.
const PAGE_CLASS = 'min-w-0'
// The status rows carry a leading icon/dot, which `SettingsRow` has no slot
// for, so they reuse its title/description type directly.
const ROW_TITLE_CLASS = 'text-[13px] font-medium leading-5 text-[var(--color-text-primary)]'

type NoticeTone = 'error' | 'warning' | 'success'

const NOTICE_CLASSES: Record<NoticeTone, string> = {
  error: 'bg-[var(--color-error-container)] text-[var(--color-on-error-container)]',
  warning: 'bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)]',
  success: 'bg-[var(--color-success-container)] text-[var(--color-on-success-container)]',
}

const NOTICE_ICONS: Record<NoticeTone, typeof CircleAlert> = {
  error: CircleAlert,
  warning: TriangleAlert,
  success: CircleCheck,
}

/** A tinted status banner: semantic container fill, no border, 14px icon. */
function Notice({ tone, children }: { tone: NoticeTone; children: ReactNode }) {
  const Icon = NOTICE_ICONS[tone]
  return (
    <div className={`flex items-start gap-2 rounded-[var(--radius-md)] px-3 py-2 text-xs leading-[1.5] ${NOTICE_CLASSES[tone]}`}>
      <Icon size={14} strokeWidth={1.75} aria-hidden="true" className="mt-px shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export function ComputerUseSettings() {
  const t = useTranslation()
  const [status, setStatus] = useState<ComputerUseStatus | null>(null)
  const [checkState, setCheckState] = useState<CheckState>('loading')
  const [configState, setConfigState] = useState<CheckState>('loading')
  const [configError, setConfigError] = useState<string | null>(null)

  const [computerUseEnabled, setComputerUseEnabled] = useState(false)
  const [enableConfirmOpen, setEnableConfirmOpen] = useState(false)
  const [enableSaving, setEnableSaving] = useState(false)
  // Native (cu-helper) Codex-style UI state
  const [cardOpening, setCardOpening] = useState(false)
  const [cardError, setCardError] = useState<string | null>(null)
  const configMutationSeqRef = useRef(0)
  const statusRequestSeqRef = useRef(0)

  const fetchStatus = useCallback(async () => {
    const requestSeq = ++statusRequestSeqRef.current
    setCheckState('loading')
    try {
      const s = await computerUseApi.getStatus()
      if (requestSeq !== statusRequestSeqRef.current) return
      setStatus(s)
      setCheckState('ready')
    } catch {
      if (requestSeq !== statusRequestSeqRef.current) return
      setCheckState('error')
    }
  }, [])

  const applyConfig = useCallback((
    configResult: Awaited<ReturnType<typeof computerUseApi.getAuthorizedApps>>,
    requestSeq = configMutationSeqRef.current,
  ) => {
    if (requestSeq !== configMutationSeqRef.current) return
    setComputerUseEnabled(configResult.enabled)
  }, [])

  const fetchConfig = useCallback(async () => {
    const requestSeq = configMutationSeqRef.current
    setConfigState('loading')
    try {
      const config = await computerUseApi.getAuthorizedApps()
      if (requestSeq !== configMutationSeqRef.current) return
      applyConfig(config, requestSeq)
      setConfigState('ready')
    } catch {
      if (requestSeq !== configMutationSeqRef.current) return
      setConfigState('error')
    }
  }, [applyConfig])

  useEffect(() => {
    fetchStatus()
    fetchConfig()
  }, [fetchStatus, fetchConfig])

  const toggleComputerUseEnabled = async (value: boolean): Promise<boolean> => {
    const requestSeq = ++configMutationSeqRef.current
    const previous = computerUseEnabled
    setConfigError(null)
    setComputerUseEnabled(value)
    try {
      await computerUseApi.setAuthorizedApps(value ? COMPUTER_USE_ENABLE_REQUEST : { enabled: false })
      if (requestSeq !== configMutationSeqRef.current) return true
      return true
    } catch {
      if (requestSeq === configMutationSeqRef.current) {
        setComputerUseEnabled(previous)
        setConfigError(t('settings.computerUse.configSaveFailed'))
      }
      return false
    }
  }

  // ── Native (cu-helper) handlers ──

  // Spawn the native cu-helper permission card, then re-read status (the card
  // resolves only when the user closes it). Safe to call even when perms are
  // already granted (the user can use the "reopen" button to revisit it).
  const openPermissionCard = useCallback(async () => {
    setCardOpening(true)
    setCardError(null)
    try {
      const result = await computerUseApi.openPermissionCard()
      if (!result.ok) throw new Error(result.reason ?? 'permission card failed')
    } catch {
      setCardError(t('settings.computerUse.openCardFailed'))
    } finally {
      setCardOpening(false)
      // Always refresh — the card may have changed OS permission state.
      await fetchStatus()
    }
  }, [t, fetchStatus])

  const requestComputerUseEnabled = (value: boolean) => {
    if (value) {
      setEnableConfirmOpen(true)
      return
    }
    void toggleComputerUseEnabled(false)
  }

  const confirmComputerUseEnabled = async () => {
    setEnableSaving(true)
    const saved = await toggleComputerUseEnabled(true)
    setEnableSaving(false)
    if (!saved) return
    setEnableConfirmOpen(false)
    if (needsComputerUsePermissionCard(status)) {
      await openPermissionCard()
    }
  }

  const enableDialog = (
    <ComputerUseEnableDialog
      open={enableConfirmOpen}
      loading={enableSaving}
      platform={status?.platform === 'darwin' ? 'darwin' : status?.platform === 'linux' ? 'linux' : 'win32'}
      onClose={() => setEnableConfirmOpen(false)}
      onConfirm={confirmComputerUseEnabled}
    />
  )

  // Wait for the platform probe before rendering runtime controls.
  if (status === null) {
    return (
      <div className={PAGE_CLASS}>
        {checkState === 'error' ? (
          <ErrorState
            size="lg"
            title={t('settings.computerUse.statusCheckFailed')}
            retryLabel={t('common.retry')}
            onRetry={fetchStatus}
          />
        ) : (
          <LoadingState size="md" label={t('common.loading')} />
        )}
      </div>
    )
  }

  // Status chooses the page implementation, while config supplies the switch
  // value. Waiting for both prevents a native disabled setting from briefly
  // rendering as enabled when the capability probe wins the race.
  if (configState === 'loading') {
    return (
      <div className={PAGE_CLASS}>
        <LoadingState size="md" label={t('common.loading')} />
      </div>
    )
  }

  if (configState === 'error') {
    return (
      <div className={PAGE_CLASS}>
        <ErrorState
          size="lg"
          title={t('settings.computerUse.configLoadFailed')}
          retryLabel={t('common.retry')}
          onRetry={fetchConfig}
        />
      </div>
    )
  }

  if (status.engine === 'unsupported') {
    const macosVersionProblem = status.platform === 'darwin'
    const versionDetectionFailed = status.cuHelper.reason === 'system_version_unknown'
    return (
      <div className={PAGE_CLASS}>
        <SettingsPageHeader
          title={t('settings.computerUse.controlTitle')}
          description={t('settings.computerUse.controlSubtitle')}
        />
        <ErrorState
          className="mt-6"
          size="lg"
          title={versionDetectionFailed
            ? t('settings.computerUse.macosDetectionFailedTitle')
            : macosVersionProblem
            ? t('settings.computerUse.macosUnsupportedTitle', { version: status.cuHelper.minimumMacosVersion })
            : t('settings.computerUse.notSupported')}
          detail={versionDetectionFailed
            ? t('settings.computerUse.macosDetectionFailedDetail')
            : macosVersionProblem
            ? t('settings.computerUse.macosUnsupportedDetail', { current: status.systemVersion ?? t('settings.computerUse.unknownVersion') })
            : undefined}
          retryLabel={versionDetectionFailed ? t('settings.computerUse.recheckBtn') : undefined}
          onRetry={versionDetectionFailed ? fetchStatus : undefined}
          tone="strong"
        />
      </div>
    )
  }

  if (status.engine === 'macos-native' || (status.engine === 'agent-desktop' && status.runtime === 'agent-desktop')) {
    return (
      <>
        <NativeComputerUse
          t={t}
          status={status}
          enabled={computerUseEnabled}
          onToggleEnabled={requestComputerUseEnabled}
          configError={configError}
          statusError={checkState === 'error'}
          cardOpening={cardOpening}
          cardError={cardError}
          onOpenCard={openPermissionCard}
          onRecheck={fetchStatus}
        />
        {enableDialog}
      </>
    )
  }

  return (
    <div className={PAGE_CLASS}>
      <ErrorState
        size="lg"
        title={t('settings.computerUse.nativeUnavailableTitle')}
        detail={t('settings.computerUse.nativeUnavailableDetail')}
        retryLabel={t('settings.computerUse.recheckBtn')}
        onRetry={fetchStatus}
        tone="strong"
      />
    </div>
  )
}

// ============================================================================
// Native runtime settings. macOS keeps its separate OS-permission controls.
// ============================================================================

type Translate = ReturnType<typeof useTranslation>

/** macOS OS-permission status row (辅助功能 / 屏幕录制): a status dot
 *  (granted=success, needed=warning, failed=danger, checking=info) + label +
 *  state badge, built to live inside a divide-y group card. Colors ride the
 *  semantic token pairs so they follow [data-theme] (stock emerald/amber shades
 *  are fixed colors — see paletteEscapes.test.ts). */
function PermissionStatusRow({
  t,
  label,
  state,
  failed = false,
}: {
  t: Translate
  label: string
  state: boolean | null
  failed?: boolean
}) {
  const granted = state === true
  const needed = state === false
  const detail = failed
    ? t('settings.computerUse.permCheckFailed')
    : granted
    ? t('settings.computerUse.permGranted')
    : needed
      ? t('settings.computerUse.permNeeded')
      : t('settings.computerUse.permChecking')
  const tone: Tone = failed
    ? 'danger'
    : granted
    ? 'success'
    : needed
      ? 'warning'
      : 'info'
  return (
    <div className="flex min-h-[52px] items-center gap-3 px-4 py-3">
      <StatusDot tone={tone} size="md" pulse={needed} />
      <span className={`min-w-0 flex-1 ${ROW_TITLE_CLASS}`}>
        {label}
      </span>
      <Badge tone={tone} size="xs">{detail}</Badge>
    </div>
  )
}

function NativeComputerUse({
  t,
  status,
  enabled,
  onToggleEnabled,
  configError,
  statusError,
  cardOpening,
  cardError,
  onOpenCard,
  onRecheck,
}: {
  t: Translate
  status: ComputerUseStatus
  enabled: boolean
  onToggleEnabled: (value: boolean) => void
  configError: string | null
  statusError: boolean
  cardOpening: boolean
  cardError: string | null
  onOpenCard: () => void
  onRecheck: () => void
}) {
  const agentDesktop = status.engine === 'agent-desktop'
  const accessibility = status.permissions.accessibility
  const screenRecording = status.permissions.screenRecording
  const permissionProbeFailed = Boolean(status.permissions.error)
  const header = (
    <SettingsPageHeader
      title={t('settings.computerUse.controlTitle')}
      description={agentDesktop
        ? t('settings.computerUse.agentDesktopSubtitle')
        : t('settings.computerUse.controlSubtitle')}
      action={(
        <Switch
          checked={enabled}
          onChange={onToggleEnabled}
          label={t('settings.computerUse.enabledToggle')}
        />
      )}
    />
  )
  const configErrorNotice = configError ? (
    <div className="mt-6">
      <Notice tone="error">{configError}</Notice>
    </div>
  ) : null

  if (statusError) {
    return (
      <div className={PAGE_CLASS}>
        {header}
        {configErrorNotice}
        <ErrorState
          className="mt-6"
          size="lg"
          title={t('settings.computerUse.statusCheckFailed')}
          retryLabel={t('common.retry')}
          onRetry={onRecheck}
          tone="strong"
        />
      </div>
    )
  }

  if (agentDesktop) {
    const runtime = status.agentDesktop
    const available = runtime?.available === true
    const missing = runtime?.reason === 'binary_missing'
    return (
      <div className={PAGE_CLASS}>
        {header}
        {configErrorNotice}
        {!enabled && (
          <div className="mt-6">
            <Notice tone="warning">{t('settings.computerUse.disabledHint')}</Notice>
          </div>
        )}
        <SettingsSection title={t('settings.computerUse.sectionControl')}>
          {available ? (
            <SettingsGroup>
              <SettingsRow
                title={t('settings.computerUse.agentDesktopRuntime')}
                description={t('settings.computerUse.agentDesktopReady')}
              >
                <Badge tone="success" size="xs">{t('settings.computerUse.agentDesktopReadyLabel')}</Badge>
              </SettingsRow>
              <SettingsRow
                title={t('settings.computerUse.agentDesktopInputTitle')}
                description={status.platform === 'linux'
                  ? t('settings.computerUse.agentDesktopLinuxInput')
                  : t('settings.computerUse.agentDesktopWindowsInput')}
              />
            </SettingsGroup>
          ) : (
            <ErrorState
              size="lg"
              title={t('settings.computerUse.nativeUnavailableTitle')}
              detail={missing
                ? t('settings.computerUse.agentDesktopMissing')
                : runtime?.message ?? t('settings.computerUse.agentDesktopProbeFailed', {
                    reason: runtime?.reason ?? t('settings.computerUse.agentDesktopNoStatus'),
                  })}
              tone="strong"
            />
          )}
          <SettingsBlock>
            <Button
              variant="secondary"
              size="base"
              onClick={onRecheck}
              icon={<RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />}
            >
              {t('settings.computerUse.recheckBtn')}
            </Button>
          </SettingsBlock>
        </SettingsSection>
      </div>
    )
  }

  if (!status.cuHelper.available) {
    const detailKey = status.cuHelper.reason === 'helper_signature_invalid'
      ? 'settings.computerUse.nativeSignatureInvalidDetail'
      : status.cuHelper.reason === 'helper_prepare_failed'
        ? 'settings.computerUse.nativePrepareFailedDetail'
        : status.cuHelper.reason === 'helper_missing'
          ? 'settings.computerUse.nativeMissingDetail'
          : 'settings.computerUse.nativeUnavailableDetail'
    return (
      <div className={PAGE_CLASS}>
        {header}
        {configErrorNotice}
        <ErrorState
          className="mt-6"
          size="lg"
          title={t('settings.computerUse.nativeUnavailableTitle')}
          detail={t(detailKey)}
          retryLabel={t('settings.computerUse.recheckBtn')}
          onRetry={onRecheck}
          tone="strong"
        />
      </div>
    )
  }

  return (
    <div className={PAGE_CLASS}>
      {header}
      {configErrorNotice}

      {/* ─── 控制 (Control) ─── */}
      <SettingsSection title={t('settings.computerUse.sectionControl')}>
        {/* One group card for the OS permissions required by the master
            toggle in the page header. */}
        <SettingsGroup>
          <SettingsRow
            title={t('settings.computerUse.osPermTitle')}
            description={t('settings.computerUse.osPermHint')}
          />
          <PermissionStatusRow
            t={t}
            label={t('settings.computerUse.accessibility')}
            state={accessibility}
            failed={permissionProbeFailed}
          />
          <PermissionStatusRow
            t={t}
            label={t('settings.computerUse.screenRecording')}
            state={screenRecording}
            failed={permissionProbeFailed}
          />
          <SettingsBlock>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="base"
                onClick={onOpenCard}
                loading={cardOpening}
                icon={<ShieldCheck size={14} strokeWidth={1.75} aria-hidden="true" />}
              >
                {cardOpening ? t('settings.computerUse.openingCard') : t('settings.computerUse.openCard')}
              </Button>
              <Button
                variant="ghost"
                size="base"
                onClick={onRecheck}
                icon={<RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />}
              >
                {t('settings.computerUse.recheckBtn')}
              </Button>
            </div>
            {cardError && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--color-error)]">
                <CircleAlert size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
                {cardError}
              </p>
            )}
          </SettingsBlock>
        </SettingsGroup>
      </SettingsSection>
    </div>
  )
}
