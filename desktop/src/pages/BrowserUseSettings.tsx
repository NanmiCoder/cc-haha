import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  CircleAlert,
  CircleCheck,
  Copy,
  Globe,
  Info,
  Plug,
  RefreshCw,
  Rocket,
  TriangleAlert,
  Unplug,
} from 'lucide-react'
import {
  browserUseApi,
  type BrowserPreferredTarget,
  type BrowserUseConfig,
  type BrowserUseStatus,
  type DetectedBrowserId,
} from '@/api/browserUse'
import { BrowserUseEnableDialog } from '@/components/browser-use/BrowserUseEnableDialog'
import {
  SettingsBlock,
  SettingsGroup,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsSection'
import { Badge, StatusDot, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/CopyButton'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Switch } from '@/components/ui/Switch'
import { useTranslation } from '@/i18n'
import { useBrowserUseStore } from '@/stores/browserUseStore'

type LoadState = 'loading' | 'ready' | 'error'
type NoticeTone = 'info' | 'error' | 'warning' | 'success'

const CHROME_REMOTE_DEBUG_URL = 'chrome://inspect/#remote-debugging'
const DETECT_POLL_INTERVAL_MS = 1500
const PAGE_CLASS = 'min-w-0'

const NOTICE_CLASSES: Record<NoticeTone, string> = {
  info: 'bg-[var(--color-info-container)] text-[var(--color-on-info-container)]',
  error: 'bg-[var(--color-error-container)] text-[var(--color-on-error-container)]',
  warning: 'bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)]',
  success: 'bg-[var(--color-success-container)] text-[var(--color-on-success-container)]',
}

const NOTICE_ICONS: Record<NoticeTone, typeof CircleAlert> = {
  info: Info,
  error: CircleAlert,
  warning: TriangleAlert,
  success: CircleCheck,
}

function Notice({ tone, children }: { tone: NoticeTone; children: ReactNode }) {
  const Icon = NOTICE_ICONS[tone]
  return (
    <div className={`flex items-start gap-2 rounded-[var(--radius-md)] px-3 py-2 text-xs leading-[1.5] ${NOTICE_CLASSES[tone]}`}>
      <Icon size={14} strokeWidth={1.75} aria-hidden="true" className="mt-px shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export function BrowserUseSettings() {
  const t = useTranslation()
  const [status, setStatus] = useState<BrowserUseStatus | null>(null)
  const [config, setConfig] = useState<BrowserUseConfig | null>(null)
  const [statusState, setStatusState] = useState<LoadState>('loading')
  const [configState, setConfigState] = useState<LoadState>('loading')
  const [configError, setConfigError] = useState<string | null>(null)
  const [chromeError, setChromeError] = useState<string | null>(null)

  const [enableDialogOpen, setEnableDialogOpen] = useState(false)
  const [enableSaving, setEnableSaving] = useState(false)
  const [selectedBrowserId, setSelectedBrowserId] = useState<DetectedBrowserId | undefined>(undefined)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [launchingManaged, setLaunchingManaged] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  const statusRequestSeqRef = useRef(0)
  const configMutationSeqRef = useRef(0)

  const applyFetchedStatus = useCallback((nextStatus: BrowserUseStatus) => {
    setStatus(nextStatus)
    useBrowserUseStore.getState().applyStatus(nextStatus)
    setSelectedBrowserId((previous) => {
      if (previous && nextStatus.chrome.detectedBrowsers.some((item) => item.id === previous)) {
        return previous
      }
      return nextStatus.chrome.browserId ?? nextStatus.chrome.detectedBrowsers[0]?.id
    })
  }, [])

  const fetchStatus = useCallback(async (options?: { silent?: boolean }) => {
    const requestSeq = ++statusRequestSeqRef.current
    if (!options?.silent) setStatusState('loading')
    try {
      const nextStatus = await browserUseApi.getStatus()
      if (requestSeq !== statusRequestSeqRef.current) return
      applyFetchedStatus(nextStatus)
      setStatusState('ready')
    } catch {
      if (requestSeq !== statusRequestSeqRef.current) return
      if (!options?.silent) setStatusState('error')
    }
  }, [applyFetchedStatus])

  const fetchConfig = useCallback(async () => {
    const requestSeq = configMutationSeqRef.current
    setConfigState('loading')
    try {
      const nextConfig = await browserUseApi.getConfig()
      if (requestSeq !== configMutationSeqRef.current) return
      setConfig(nextConfig)
      useBrowserUseStore.setState({ config: nextConfig, loaded: true })
      setConfigState('ready')
    } catch {
      if (requestSeq !== configMutationSeqRef.current) return
      setConfigState('error')
    }
  }, [])

  useEffect(() => {
    void fetchStatus()
    void fetchConfig()
  }, [fetchStatus, fetchConfig])

  const chromeConnected = status?.chrome.mode === 'live_attach' || status?.chrome.mode === 'managed'

  // Poll every 1.5s while the 2-step Live Attach wizard is open so turning on
  // remote debugging in Chrome turns the status indicator green automatically.
  useEffect(() => {
    if (!wizardOpen || chromeConnected) return
    const timer = window.setInterval(() => {
      void fetchStatus({ silent: true })
    }, DETECT_POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [wizardOpen, chromeConnected, fetchStatus])

  const patchConfig = async (patch: Partial<BrowserUseConfig>): Promise<boolean> => {
    const requestSeq = ++configMutationSeqRef.current
    const previous = config
    setConfigError(null)
    if (previous) {
      const optimistic = { ...previous, ...patch }
      setConfig(optimistic)
      useBrowserUseStore.setState((state) => ({
        config: optimistic,
        status: state.status
          ? { ...state.status, enabled: optimistic.enabled, preferredTarget: optimistic.preferredTarget, config: optimistic }
          : state.status,
      }))
    }
    try {
      const saved = await browserUseApi.updateConfig(patch)
      if (requestSeq !== configMutationSeqRef.current) return true
      setConfig(saved)
      useBrowserUseStore.setState((state) => ({
        config: saved,
        loaded: true,
        status: state.status
          ? { ...state.status, enabled: saved.enabled, preferredTarget: saved.preferredTarget, config: saved }
          : state.status,
      }))
      return true
    } catch {
      if (requestSeq === configMutationSeqRef.current) {
        setConfig(previous)
        if (previous) {
          useBrowserUseStore.setState((state) => ({
            config: previous,
            status: state.status
              ? { ...state.status, enabled: previous.enabled, preferredTarget: previous.preferredTarget, config: previous }
              : state.status,
          }))
        }
        setConfigError(t('settings.browserUse.configSaveFailed'))
      }
      return false
    }
  }

  const handleToggleEnabled = (nextEnabled: boolean) => {
    if (nextEnabled) {
      setEnableDialogOpen(true)
      return
    }
    void patchConfig({ enabled: false })
  }

  const handleConfirmEnable = async () => {
    setEnableSaving(true)
    const saved = await patchConfig({
      enabled: true,
      consentAcceptedAt: new Date().toISOString(),
    })
    setEnableSaving(false)
    if (saved) setEnableDialogOpen(false)
  }

  const handleConnectChrome = async () => {
    setConnecting(true)
    setChromeError(null)
    try {
      const result = await browserUseApi.connectChrome({
        browserId: selectedBrowserId,
      })
      applyFetchedStatus(result.status)
      if (!result.ok) {
        setChromeError(result.error ?? result.chrome.error ?? result.chrome.guidance ?? t('settings.browserUse.chromeConnectFailed'))
      }
    } catch (error) {
      setChromeError(error instanceof Error ? error.message : t('settings.browserUse.chromeConnectFailed'))
    } finally {
      setConnecting(false)
    }
  }

  const handleLaunchManaged = async () => {
    setLaunchingManaged(true)
    setChromeError(null)
    try {
      const result = await browserUseApi.launchManagedChrome({
        browserId: selectedBrowserId,
      })
      applyFetchedStatus(result.status)
      if (!result.ok) {
        setChromeError(result.error ?? result.chrome.error ?? t('settings.browserUse.chromeLaunchFailed'))
      }
    } catch (error) {
      setChromeError(error instanceof Error ? error.message : t('settings.browserUse.chromeLaunchFailed'))
    } finally {
      setLaunchingManaged(false)
    }
  }

  const handleDisconnectChrome = async () => {
    setDisconnecting(true)
    setChromeError(null)
    try {
      const result = await browserUseApi.disconnectChrome()
      applyFetchedStatus(result.status)
    } catch (error) {
      setChromeError(error instanceof Error ? error.message : t('settings.browserUse.chromeDisconnectFailed'))
    } finally {
      setDisconnecting(false)
    }
  }

  if (status === null) {
    return (
      <div className={PAGE_CLASS}>
        {statusState === 'error' ? (
          <ErrorState
            size="lg"
            title={t('settings.browserUse.statusCheckFailed')}
            retryLabel={t('common.retry')}
            onRetry={() => { void fetchStatus() }}
          />
        ) : (
          <LoadingState size="md" label={t('common.loading')} />
        )}
      </div>
    )
  }

  if (configState === 'loading' || config === null) {
    return (
      <div className={PAGE_CLASS}>
        {configState === 'error' ? (
          <ErrorState
            size="lg"
            title={t('settings.browserUse.configLoadFailed')}
            retryLabel={t('common.retry')}
            onRetry={() => { void fetchConfig() }}
          />
        ) : (
          <LoadingState size="md" label={t('common.loading')} />
        )}
      </div>
    )
  }

  const detectedBrowsers = status.chrome.detectedBrowsers
  const selectedBrowser = detectedBrowsers.find((b) => b.id === selectedBrowserId) ?? detectedBrowsers[0]
  const livePortDetected = Boolean(selectedBrowser?.hasDevToolsActivePort)
  const awaitingApproval = status.chrome.mode === 'awaiting_approval'

  const chromeBadgeTone: Tone = chromeConnected
    ? 'success'
    : awaitingApproval
      ? 'warning'
      : status.chrome.mode === 'error'
        ? 'danger'
        : 'neutral'

  const chromeBadgeLabel = status.chrome.mode === 'live_attach'
    ? t('settings.browserUse.chromeStatusLive')
    : status.chrome.mode === 'managed'
      ? t('settings.browserUse.chromeStatusManaged')
      : awaitingApproval
        ? t('settings.browserUse.chromeStatusAwaitingApproval')
        : status.chrome.mode === 'error'
          ? t('settings.browserUse.chromeStatusError')
          : t('settings.browserUse.chromeStatusDisconnected')

  const targetOptions: Array<{ value: BrowserPreferredTarget; label: string }> = [
    { value: 'auto', label: t('settings.browserUse.targetAuto') },
    { value: 'workspace', label: t('settings.browserUse.targetWorkspace') },
    { value: 'chrome', label: t('settings.browserUse.targetChrome') },
  ]

  return (
    <div className={PAGE_CLASS}>
      <SettingsPageHeader
        title={t('settings.browserUse.title')}
        description={t('settings.browserUse.subtitle')}
        action={(
          <Switch
            checked={config.enabled}
            onChange={handleToggleEnabled}
            label={t('settings.browserUse.enabledToggle')}
          />
        )}
      />

      {configError ? (
        <div className="mt-6">
          <Notice tone="error">{configError}</Notice>
        </div>
      ) : null}

      {!config.enabled ? (
        <div className="mt-6">
          <Notice tone="warning">{t('settings.browserUse.disabledHint')}</Notice>
        </div>
      ) : null}

      <div className="mt-6">
        <Notice tone="info">{t('settings.browserUse.divisionNotice')}</Notice>
      </div>

      {/* ─── Built-in Workspace Browser ─── */}
      <SettingsSection
        title={t('settings.browserUse.sectionWorkspace')}
        description={t('settings.browserUse.sectionWorkspaceDesc')}
      >
        <SettingsGroup>
          <SettingsRow
            title={t('settings.browserUse.workspaceStatusTitle')}
            description={status.workspaceAvailable
              ? t('settings.browserUse.workspaceReadyDesc')
              : t('settings.browserUse.workspaceUnavailableDesc')}
          >
            <div className="flex items-center gap-2">
              <StatusDot tone={status.workspaceAvailable ? 'success' : 'warning'} size="sm" />
              <Badge tone={status.workspaceAvailable ? 'success' : 'warning'} size="xs">
                {status.workspaceAvailable
                  ? t('settings.browserUse.workspaceReadyBadge')
                  : t('settings.browserUse.workspaceUnavailableBadge')}
              </Badge>
            </div>
          </SettingsRow>
          <SettingsRow
            title={t('settings.browserUse.preferredTargetTitle')}
            description={t('settings.browserUse.preferredTargetDesc')}
          >
            <SegmentedControl
              label={t('settings.browserUse.preferredTargetTitle')}
              value={config.preferredTarget}
              onChange={(preferredTarget) => { void patchConfig({ preferredTarget }) }}
              items={targetOptions}
              size="sm"
            />
          </SettingsRow>
          <SettingsRow
            title={t('settings.browserUse.showCursorOverlayTitle')}
            description={t('settings.browserUse.showCursorOverlayDesc')}
          >
            <Switch
              checked={config.showCursorOverlay}
              onChange={(showCursorOverlay) => { void patchConfig({ showCursorOverlay }) }}
              label={t('settings.browserUse.showCursorOverlayTitle')}
            />
          </SettingsRow>
          <SettingsRow
            title={t('settings.browserUse.autoOpenPanelTitle')}
            description={t('settings.browserUse.autoOpenPanelDesc')}
          >
            <Switch
              checked={config.autoOpenWorkspacePanel}
              onChange={(autoOpenWorkspacePanel) => { void patchConfig({ autoOpenWorkspacePanel }) }}
              label={t('settings.browserUse.autoOpenPanelTitle')}
            />
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      {/* ─── System Browser (Chrome / Edge / Brave) ─── */}
      <SettingsSection
        title={t('settings.browserUse.sectionChrome')}
        description={t('settings.browserUse.sectionChromeDesc')}
        action={(
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { void fetchStatus() }}
            icon={<RefreshCw size={13} strokeWidth={1.75} aria-hidden="true" />}
          >
            {t('settings.browserUse.refreshBtn')}
          </Button>
        )}
      >
        <SettingsGroup>
          <SettingsRow
            title={t('settings.browserUse.chromeConnectionTitle')}
            description={chromeConnected
              ? [status.chrome.browserName, status.chrome.browserVersion, status.chrome.port ? `:${status.chrome.port}` : null]
                  .filter(Boolean)
                  .join(' · ')
              : t('settings.browserUse.chromeConnectionDesc')}
          >
            <div className="flex items-center gap-2">
              <StatusDot tone={chromeBadgeTone} size="sm" pulse={awaitingApproval} />
              <Badge tone={chromeBadgeTone} size="xs">{chromeBadgeLabel}</Badge>
              {chromeConnected ? (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={disconnecting}
                  onClick={() => { void handleDisconnectChrome() }}
                  icon={<Unplug size={13} strokeWidth={1.75} aria-hidden="true" />}
                >
                  {t('settings.browserUse.disconnectBtn')}
                </Button>
              ) : null}
            </div>
          </SettingsRow>

          {/* Detected browsers list */}
          <SettingsBlock>
            <div className="space-y-3">
              <div className="text-[12px] font-medium text-[var(--color-text-secondary)]">
                {t('settings.browserUse.detectedBrowsersLabel')}
              </div>
              {detectedBrowsers.length === 0 ? (
                <p className="text-xs text-[var(--color-text-tertiary)]">
                  {t('settings.browserUse.noBrowsersDetected')}
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {detectedBrowsers.map((browser) => {
                    const selected = browser.id === selectedBrowser?.id
                    return (
                      <button
                        key={browser.id}
                        type="button"
                        onClick={() => setSelectedBrowserId(browser.id)}
                        data-testid={`detected-browser-${browser.id}`}
                        className={`flex items-center justify-between gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
                          selected
                            ? 'border-[var(--color-primary-fixed-dim)] bg-[var(--color-brand-soft)]'
                            : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)]'
                        }`}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <Globe size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-secondary)]" />
                          <span className="truncate text-[13px] font-medium text-[var(--color-text-primary)]">
                            {browser.name}
                          </span>
                        </div>
                        <Badge tone={browser.hasDevToolsActivePort ? 'success' : 'neutral'} size="xs">
                          {browser.hasDevToolsActivePort
                            ? t('settings.browserUse.debugPortReady')
                            : t('settings.browserUse.debugPortOff')}
                        </Badge>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </SettingsBlock>

          {/* Live Attach 2-step interactive wizard */}
          <SettingsBlock>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[13px] font-medium text-[var(--color-text-primary)]">
                    {t('settings.browserUse.liveAttachTitle')}
                  </div>
                  <p className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">
                    {t('settings.browserUse.liveAttachDesc')}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setWizardOpen((open) => !open)}
                >
                  {wizardOpen
                    ? t('settings.browserUse.hideWizardBtn')
                    : t('settings.browserUse.openWizardBtn')}
                </Button>
              </div>

              {wizardOpen ? (
                <div
                  data-testid="chrome-live-attach-wizard"
                  className="space-y-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5"
                >
                  <div className="space-y-1.5">
                    <div className="text-xs font-semibold text-[var(--color-text-primary)]">
                      {t('settings.browserUse.wizardStep1Title')}
                    </div>
                    <p className="text-xs leading-[1.5] text-[var(--color-text-secondary)]">
                      {t('settings.browserUse.wizardStep1Desc')}
                    </p>
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <code className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-container)] px-2.5 py-1 font-mono text-xs text-[var(--color-text-primary)]">
                        {CHROME_REMOTE_DEBUG_URL}
                      </code>
                      <CopyButton
                        text={CHROME_REMOTE_DEBUG_URL}
                        label={t('settings.browserUse.copyInspectUrl')}
                        copiedLabel={t('settings.browserUse.copiedInspectUrl')}
                        displayLabel={(
                          <span className="inline-flex items-center gap-1.5">
                            <Copy size={12} strokeWidth={1.75} aria-hidden="true" />
                            {t('settings.browserUse.copyInspectUrl')}
                          </span>
                        )}
                        displayCopiedLabel={(
                          <span className="inline-flex items-center gap-1.5">
                            <CircleCheck size={12} strokeWidth={1.75} aria-hidden="true" />
                            {t('settings.browserUse.copiedInspectUrl')}
                          </span>
                        )}
                        className="inline-flex h-7 items-center rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-container)] px-2.5 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5 border-t border-[var(--color-border)] pt-3">
                    <div className="text-xs font-semibold text-[var(--color-text-primary)]">
                      {t('settings.browserUse.wizardStep2Title')}
                    </div>
                    <p className="text-xs leading-[1.5] text-[var(--color-text-secondary)]">
                      {t('settings.browserUse.wizardStep2Desc')}
                    </p>
                    <div
                      data-testid="chrome-debug-port-status"
                      className={`mt-2 flex items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs ${
                        livePortDetected
                          ? 'bg-[var(--color-success-container)] text-[var(--color-on-success-container)]'
                          : 'bg-[var(--color-surface-container)] text-[var(--color-text-secondary)]'
                      }`}
                    >
                      <StatusDot tone={livePortDetected ? 'success' : 'info'} size="sm" pulse={!livePortDetected} />
                      <span>
                        {livePortDetected
                          ? t('settings.browserUse.wizardPortDetected')
                          : t('settings.browserUse.wizardPortWaiting')}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Button
                      variant="primary"
                      size="sm"
                      loading={connecting}
                      disabled={detectedBrowsers.length === 0 || chromeConnected}
                      onClick={() => { void handleConnectChrome() }}
                      icon={<Plug size={13} strokeWidth={1.75} aria-hidden="true" />}
                    >
                      {connecting
                        ? t('settings.browserUse.connectingBtn')
                        : t('settings.browserUse.connectBtn')}
                    </Button>
                    <span className="text-xs text-[var(--color-text-tertiary)]">
                      {t('settings.browserUse.approvalGuidance')}
                    </span>
                  </div>
                </div>
              ) : null}

              {awaitingApproval ? (
                <Notice tone="warning">{t('settings.browserUse.awaitingApprovalNotice')}</Notice>
              ) : null}
              {chromeError ? (
                <Notice tone="error">{chromeError}</Notice>
              ) : null}
            </div>
          </SettingsBlock>

          {/* Managed Isolated Chrome */}
          <SettingsRow
            title={t('settings.browserUse.managedChromeTitle')}
            description={t('settings.browserUse.managedChromeDesc')}
          >
            <Button
              variant="secondary"
              size="base"
              loading={launchingManaged}
              disabled={detectedBrowsers.length === 0 || chromeConnected}
              onClick={() => { void handleLaunchManaged() }}
              icon={<Rocket size={14} strokeWidth={1.75} aria-hidden="true" />}
            >
              {launchingManaged
                ? t('settings.browserUse.launchingManagedBtn')
                : t('settings.browserUse.launchManagedBtn')}
            </Button>
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <BrowserUseEnableDialog
        open={enableDialogOpen}
        loading={enableSaving}
        onClose={() => setEnableDialogOpen(false)}
        onConfirm={handleConfirmEnable}
      />
    </div>
  )
}
