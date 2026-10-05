import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  Download,
  ExternalLink,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react'
import { computerUseApi, type ComputerUseStatus, type SetupResult } from '../api/computerUse'
import { useTranslation } from '../i18n'
import { ComputerUseEnableDialog } from '@/components/computer-use/ComputerUseEnableDialog'
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
import { Input } from '@/components/ui/Input'
import { LoadingState } from '@/components/ui/LoadingState'
import { Switch } from '@/components/ui/Switch'
import { getDesktopHost } from '../lib/desktopHost'

type CheckState = 'loading' | 'ready' | 'error'
const PYTHON_DOWNLOAD_URLS: Record<string, string> = {
  darwin: 'https://www.python.org/downloads/macos/',
  win32: 'https://www.python.org/downloads/windows/',
}

// Settings.tsx owns the page frame (width, gutters); a pane is just a column.
const PAGE_CLASS = 'min-w-0'
// The status rows carry a leading icon/dot, which `SettingsRow` has no slot
// for, so they reuse its title/description type directly.
const ROW_TITLE_CLASS = 'text-[13px] font-medium leading-5 text-[var(--color-text-primary)]'
const ROW_DESC_CLASS = 'mt-0.5 text-xs leading-[1.5] text-[var(--color-text-tertiary)]'

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

function StatusIcon({ ok }: { ok: boolean | null }) {
  if (ok === null) {
    return <CircleHelp size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
  }
  return ok ? (
    <CircleCheck size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-success)]" />
  ) : (
    <CircleX size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-error)]" />
  )
}

function StatusRow({ label, ok, detail }: { label: string; ok: boolean | null; detail: string }) {
  return (
    <div className="flex min-h-[52px] items-center gap-3 px-4 py-3">
      <StatusIcon ok={ok} />
      <div className="min-w-0 flex-1">
        <div className={ROW_TITLE_CLASS}>{label}</div>
        <div className={`${ROW_DESC_CLASS} break-all`}>{detail}</div>
      </div>
    </div>
  )
}

async function openSystemSettings(pane: 'Privacy_ScreenCapture' | 'Privacy_Accessibility') {
  await computerUseApi.openSettings(pane)
}

async function openExternalUrl(url: string) {
  const host = getDesktopHost()
  try {
    await host.shell.open(url)
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

export function ComputerUseSettings() {
  const t = useTranslation()
  const [status, setStatus] = useState<ComputerUseStatus | null>(null)
  const [checkState, setCheckState] = useState<CheckState>('loading')
  const [configState, setConfigState] = useState<CheckState>('loading')
  const [configError, setConfigError] = useState<string | null>(null)
  const [setupRunning, setSetupRunning] = useState(false)
  const [setupResult, setSetupResult] = useState<SetupResult | null>(null)

  const [computerUseEnabled, setComputerUseEnabled] = useState(false)
  const [enableConfirmOpen, setEnableConfirmOpen] = useState(false)
  const [enableSaving, setEnableSaving] = useState(false)
  const [pythonPathDraft, setPythonPathDraft] = useState('')
  const [pythonPathSaved, setPythonPathSaved] = useState('')
  const [pythonPathSaving, setPythonPathSaving] = useState(false)
  const [pythonPathMessage, setPythonPathMessage] = useState<string | null>(null)
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
    setPythonPathDraft(configResult.pythonPath ?? '')
    setPythonPathSaved(configResult.pythonPath ?? '')
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

  const envReady = status?.venv.created && status?.dependencies.installed

  const handleSetup = async () => {
    setSetupRunning(true)
    setSetupResult(null)
    try {
      const result = await computerUseApi.runSetup()
      setSetupResult(result)
      await fetchStatus()
    } catch {
      setSetupResult({ success: false, steps: [{ name: 'error', ok: false, message: 'Request failed' }] })
    } finally {
      setSetupRunning(false)
    }
  }

  const toggleComputerUseEnabled = async (value: boolean): Promise<boolean> => {
    const requestSeq = ++configMutationSeqRef.current
    const previous = computerUseEnabled
    setConfigError(null)
    setComputerUseEnabled(value)
    try {
      await computerUseApi.setAuthorizedApps(value
        ? {
            enabled: true,
            grantFlags: {
              clipboardRead: true,
              clipboardWrite: true,
              systemKeyCombos: true,
            },
          }
        : { enabled: false })
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
    if (
      status?.engine === 'macos-native'
      && (status.permissions.accessibility === false
        || status.permissions.screenRecording === false)
    ) {
      await openPermissionCard()
    }
  }

  const savePythonPath = async (value = pythonPathDraft) => {
    configMutationSeqRef.current += 1
    const normalized = value.trim()
    setPythonPathSaving(true)
    setPythonPathMessage(null)
    try {
      await computerUseApi.setAuthorizedApps({ pythonPath: normalized || null })
      setPythonPathDraft(normalized)
      setPythonPathSaved(normalized)
      setPythonPathMessage(t('settings.computerUse.pythonPathSaved'))
      await fetchStatus()
    } catch {
      setPythonPathMessage(t('settings.computerUse.pythonPathSaveFailed'))
    } finally {
      setPythonPathSaving(false)
    }
  }

  const choosePythonPath = async () => {
    const host = getDesktopHost()
    if (!host.capabilities.dialogs) {
      setPythonPathMessage(t('settings.computerUse.pythonPathDialogFailed'))
      return
    }
    try {
      const selected = await host.dialogs.open({
        multiple: false,
        directory: false,
        title: t('settings.computerUse.pythonPathDialogTitle'),
      })
      const selectedPath = Array.isArray(selected) ? selected[0] : selected
      if (typeof selectedPath === 'string' && selectedPath.trim()) {
        setPythonPathDraft(selectedPath)
        await savePythonPath(selectedPath)
      }
    } catch {
      setPythonPathMessage(t('settings.computerUse.pythonPathDialogFailed'))
    }
  }

  const allReady =
    status?.supported &&
    status.python.installed &&
    status.venv.created &&
    status.dependencies.installed

  const accessibilityNeedsAttention = status?.permissions.accessibility === false
  const screenRecordingNeedsAttention = status?.permissions.screenRecording === false
  const screenRecordingReady = status ? status.permissions.screenRecording !== false : null
  const pythonDownloadUrl = status
    ? PYTHON_DOWNLOAD_URLS[status.platform] ?? 'https://www.python.org/downloads/'
    : 'https://www.python.org/downloads/'
  const pythonPathDirty = pythonPathDraft.trim() !== pythonPathSaved
  const pythonDetail = status?.python.installed
    ? `${t('settings.computerUse.pythonFound')} — ${status.python.version} (${status.python.path})`
    : status?.python.source === 'custom'
      ? `${t('settings.computerUse.pythonCustomInvalid')} — ${status.python.path}${status.python.error ? `: ${status.python.error}` : ''}`
      : t('settings.computerUse.pythonNotFound')

  // Native (cu-helper) path: drop the entire Python setup flow in favor of the
  // Codex-style page. Branch ONLY when on macOS AND the Swift helper resolves.
  const native = status?.engine === 'macos-native'

  const enableDialog = (
    <ComputerUseEnableDialog
      open={enableConfirmOpen}
      loading={enableSaving}
      platform={status?.platform === 'darwin' ? 'darwin' : 'win32'}
      onClose={() => setEnableConfirmOpen(false)}
      onConfirm={confirmComputerUseEnabled}
    />
  )

  // The renderer cannot choose between the native macOS page and the
  // compatibility page until the capability probe finishes. Rendering the
  // compatibility page here used to flash its header toggle before the native
  // page replaced the entire tree.
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

  if (native && status) {
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

  // The Python compatibility page is Windows-only. Missing or future engine
  // values (for example during a rolling sidecar/UI upgrade) fail closed on
  // the native page instead of resurrecting the retired macOS setup screen.
  if (status.engine !== 'windows-compat') {
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

  return (
    <>
      <div className={PAGE_CLASS}>
        <SettingsPageHeader
          title={t('settings.computerUse.title')}
          description={t('settings.computerUse.description')}
          action={(
            <Switch
              checked={computerUseEnabled}
              onChange={requestComputerUseEnabled}
              label={t('settings.computerUse.enabledToggle')}
            />
          )}
        />

        <div className="mt-6 space-y-4">
          {configError && <Notice tone="error">{configError}</Notice>}

          {!computerUseEnabled && (
            <Notice tone="warning">{t('settings.computerUse.disabledHint')}</Notice>
          )}

          {checkState === 'loading' ? (
            <LoadingState size="md" label={t('common.loading')} />
          ) : checkState === 'error' ? (
            <ErrorState
              size="lg"
              title={t('settings.computerUse.statusCheckFailed')}
              retryLabel={t('common.retry')}
              onRetry={fetchStatus}
            />
          ) : status ? (
            <>
              {!status.supported && (
                <Notice tone="warning">{t('settings.computerUse.notSupported')}</Notice>
              )}

              {/* Status checks */}
              <SettingsGroup>
                <StatusRow
                  label={t('settings.computerUse.python')}
                  ok={status.python.installed}
                  detail={pythonDetail}
                />
                <StatusRow
                  label={t('settings.computerUse.venv')}
                  ok={status.venv.created}
                  detail={status.venv.created ? `${t('settings.computerUse.venvReady')} — ${status.venv.path}` : t('settings.computerUse.venvNotReady')}
                />
                <StatusRow
                  label={t('settings.computerUse.deps')}
                  ok={status.dependencies.installed}
                  detail={status.dependencies.installed ? t('settings.computerUse.depsReady') : t('settings.computerUse.depsNotReady')}
                />
              </SettingsGroup>

              <SettingsGroup>
                <SettingsRow
                  title={t('settings.computerUse.pythonPathLabel')}
                  description={pythonPathMessage ?? t('settings.computerUse.pythonPathHint')}
                  htmlFor="computer-use-python-path"
                  layout="stack"
                >
                  <Input
                    id="computer-use-python-path"
                    type="text"
                    size="md"
                    containerClassName="min-w-[220px] flex-1"
                    className="font-mono"
                    value={pythonPathDraft}
                    onChange={e => {
                      setPythonPathDraft(e.target.value)
                      setPythonPathMessage(null)
                    }}
                    placeholder={t('settings.computerUse.pythonPathPlaceholder')}
                  />
                  <Button
                    variant="secondary"
                    size="base"
                    onClick={choosePythonPath}
                    disabled={pythonPathSaving}
                    icon={<FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />}
                  >
                    {t('settings.computerUse.pythonPathBrowse')}
                  </Button>
                  <Button
                    variant="primary"
                    size="base"
                    onClick={() => savePythonPath()}
                    disabled={!pythonPathDirty}
                    loading={pythonPathSaving}
                    icon={<Save size={14} strokeWidth={1.75} aria-hidden="true" />}
                  >
                    {t('settings.computerUse.pythonPathSave')}
                  </Button>
                  {pythonPathSaved && (
                    <Button
                      variant="secondary"
                      size="base"
                      onClick={() => savePythonPath('')}
                      disabled={pythonPathSaving}
                      icon={<RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />}
                    >
                      {t('settings.computerUse.pythonPathAuto')}
                    </Button>
                  )}
                </SettingsRow>
              </SettingsGroup>

              {/* macOS Permissions — only shown on macOS (darwin) */}
              {envReady && status.platform === 'darwin' && (
                <>
                  <SettingsGroup>
                    <StatusRow
                      label={t('settings.computerUse.accessibility')}
                      ok={status.permissions.accessibility}
                      detail={
                        status.permissions.accessibility === null ? t('settings.computerUse.permUnknown')
                          : status.permissions.accessibility ? t('settings.computerUse.permGranted')
                            : t('settings.computerUse.permDenied')
                      }
                    />
                    <StatusRow
                      label={t('settings.computerUse.screenRecording')}
                      ok={screenRecordingReady}
                      detail={
                        status.permissions.screenRecording === true ? t('settings.computerUse.permGranted')
                          : status.permissions.screenRecording === false ? t('settings.computerUse.permDenied')
                            : t('settings.computerUse.permScreenRecordingUnknownSoft')
                      }
                    />
                  </SettingsGroup>
                  {(accessibilityNeedsAttention || screenRecordingNeedsAttention) && (
                    <Notice tone="warning">
                      <p>{t('settings.computerUse.permRestartHint')}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {accessibilityNeedsAttention && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => openSystemSettings('Privacy_Accessibility')}
                            icon={<ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />}
                          >
                            {t('settings.computerUse.openAccessibility')}
                          </Button>
                        )}
                        {screenRecordingNeedsAttention && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => openSystemSettings('Privacy_ScreenCapture')}
                            icon={<ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />}
                          >
                            {t('settings.computerUse.openScreenRecording')}
                          </Button>
                        )}
                      </div>
                    </Notice>
                  )}
                </>
              )}

              {allReady && (status.platform !== 'darwin' || (status.permissions.accessibility && screenRecordingReady)) && (
                <Notice tone="success">{t('settings.computerUse.allReady')}</Notice>
              )}

              {setupResult && (
                <Notice tone={setupResult.success ? 'success' : 'error'}>
                  <div className="font-medium">
                    {setupResult.success ? t('settings.computerUse.setupSuccess') : t('settings.computerUse.setupFail')}
                  </div>
                  <div className="mt-1.5 space-y-1">
                    {setupResult.steps.map((step, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <StatusIcon ok={step.ok} />
                        <span className="min-w-0 break-words">{step.message}</span>
                      </div>
                    ))}
                  </div>
                </Notice>
              )}

              {/* Action buttons */}
              <div className="flex flex-wrap gap-2">
                {!status.python.installed && (
                  <Button
                    variant="primary"
                    size="base"
                    onClick={() => openExternalUrl(pythonDownloadUrl)}
                    icon={<ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />}
                  >
                    {t('settings.computerUse.downloadPython')}
                  </Button>
                )}
                {!envReady && status.python.installed && (
                  <Button
                    variant="primary"
                    size="base"
                    onClick={handleSetup}
                    loading={setupRunning}
                    icon={<Download size={14} strokeWidth={1.75} aria-hidden="true" />}
                  >
                    {setupRunning ? t('settings.computerUse.setupRunning') : t('settings.computerUse.setupBtn')}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="base"
                  onClick={fetchStatus}
                  icon={<RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />}
                >
                  {t('settings.computerUse.recheckBtn')}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </div>
      {enableDialog}
    </>
  )
}

// ============================================================================
// Native (cu-helper) Codex-style page — macOS only, no Python.
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
  const accessibility = status.permissions.accessibility
  const screenRecording = status.permissions.screenRecording
  const permissionProbeFailed = Boolean(status.permissions.error)
  const header = (
    <SettingsPageHeader
      title={t('settings.computerUse.controlTitle')}
      description={t('settings.computerUse.controlSubtitle')}
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

  if (!status.cuHelper.available) {
    return (
      <div className={PAGE_CLASS}>
        {header}
        {configErrorNotice}
        <ErrorState
          className="mt-6"
          size="lg"
          title={t('settings.computerUse.nativeUnavailableTitle')}
          detail={t('settings.computerUse.nativeUnavailableDetail')}
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
