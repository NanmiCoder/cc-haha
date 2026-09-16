import { useState, useEffect, useCallback, useRef } from 'react'
import { computerUseApi, type ComputerUseStatus, type SetupResult } from '../api/computerUse'
import { useTranslation } from '../i18n'
import { ComputerUseEnableDialog } from '@/components/computer-use/ComputerUseEnableDialog'
import { Button } from '@/components/ui/Button'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
import { Switch } from '@/components/ui/Switch'
import { getDesktopHost } from '../lib/desktopHost'

type CheckState = 'loading' | 'ready' | 'error'
const PYTHON_DOWNLOAD_URLS: Record<string, string> = {
  darwin: 'https://www.python.org/downloads/macos/',
  win32: 'https://www.python.org/downloads/windows/',
}

function StatusIcon({ ok }: { ok: boolean | null }) {
  if (ok === null) {
    return <span className="material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)]">help</span>
  }
  return ok ? (
    <span className="material-symbols-outlined text-[18px] text-[var(--color-success)]" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
  ) : (
    <span className="material-symbols-outlined text-[18px] text-[var(--color-error)]" style={{ fontVariationSettings: "'FILL' 1" }}>cancel</span>
  )
}

function StatusRow({ label, ok, detail }: { label: string; ok: boolean | null; detail: string }) {
  return (
    <div className="flex items-center gap-3 py-2.5 px-4 rounded-[var(--radius-lg)] bg-[var(--color-surface-container-low)]">
      <StatusIcon ok={ok} />
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium text-[var(--color-text-primary)]">{label}</span>
        <span className="ml-2 text-xs text-[var(--color-text-tertiary)]">{detail}</span>
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
      <div className="max-w-2xl">
        {checkState === 'error' ? (
          <ErrorState
            size="lg"
            title="Failed to check status."
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
      <div className="max-w-2xl">
        <LoadingState size="md" label={t('common.loading')} />
      </div>
    )
  }

  if (configState === 'error') {
    return (
      <div className="max-w-2xl">
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
      <div className="max-w-2xl space-y-5">
        <div>
          <h2 className="text-[24px] font-semibold leading-tight text-[var(--color-text-primary)]" style={{ fontFamily: 'var(--font-headline)' }}>
            {t('settings.computerUse.controlTitle')}
          </h2>
          <p className="mt-1.5 text-[13.5px] leading-6 text-[var(--color-text-secondary)]">
            {t('settings.computerUse.controlSubtitle')}
          </p>
        </div>
        <ErrorState
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
      <div className="max-w-2xl space-y-5">
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
      <div className="max-w-2xl space-y-6">
      {/* Title */}
      <div>
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-[24px] font-semibold leading-tight text-[var(--color-text-primary)]" style={{ fontFamily: 'var(--font-headline)' }}>
            {t('settings.computerUse.title')}
          </h2>
          <Switch
            checked={computerUseEnabled}
            onChange={requestComputerUseEnabled}
            label={t('settings.computerUse.enabledToggle')}
            size="sm"
          />
        </div>
        <p className="mt-1.5 text-[13.5px] leading-6 text-[var(--color-text-secondary)]">
          {t('settings.computerUse.description')}
        </p>
      </div>

      {configError && (
        <div className="px-4 py-3 rounded-[var(--radius-lg)] border border-[var(--color-error)] bg-[var(--color-error-container)] text-sm text-[var(--color-on-error-container)]">
          {configError}
        </div>
      )}

      {!computerUseEnabled && (
        <div className="px-4 py-3 rounded-[var(--radius-lg)] border border-[var(--color-warning)] bg-[var(--color-warning-container)] text-sm text-[var(--color-on-warning-container)]">
          {t('settings.computerUse.disabledHint')}
        </div>
      )}

      {checkState === 'loading' ? (
        <LoadingState size="md" label={t('common.loading')} />
      ) : checkState === 'error' ? (
        <ErrorState
          size="lg"
          title="Failed to check status."
          retryLabel={t('common.retry')}
          onRetry={fetchStatus}
        />
      ) : status ? (
        <>
          {!status.supported && (
            <div className="px-4 py-3 rounded-[var(--radius-lg)] border border-[var(--color-warning)] bg-[var(--color-warning-container)] text-sm text-[var(--color-on-warning-container)]">
              {t('settings.computerUse.notSupported')}
            </div>
          )}

          {/* Status checks */}
          <div className="space-y-2">
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
          </div>

          <div className="space-y-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4">
            <label htmlFor="computer-use-python-path" className="block text-sm font-medium text-[var(--color-text-primary)]">
              {t('settings.computerUse.pythonPathLabel')}
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                id="computer-use-python-path"
                type="text"
                value={pythonPathDraft}
                onChange={e => {
                  setPythonPathDraft(e.target.value)
                  setPythonPathMessage(null)
                }}
                placeholder={t('settings.computerUse.pythonPathPlaceholder')}
                className="min-w-[220px] flex-1 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container)] px-3 py-2 font-mono text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-brand)] focus:outline-none"
              />
              <Button
                variant="secondary"
                size="base"
                onClick={choosePythonPath}
                disabled={pythonPathSaving}
                icon={<span className="material-symbols-outlined text-[16px]">folder_open</span>}
              >
                {t('settings.computerUse.pythonPathBrowse')}
              </Button>
              <Button
                variant="primary"
                size="base"
                onClick={() => savePythonPath()}
                disabled={!pythonPathDirty}
                loading={pythonPathSaving}
                icon={<span className="material-symbols-outlined text-[16px]">save</span>}
              >
                {t('settings.computerUse.pythonPathSave')}
              </Button>
              {pythonPathSaved && (
                <Button
                  variant="secondary"
                  size="base"
                  onClick={() => savePythonPath('')}
                  disabled={pythonPathSaving}
                  icon={<span className="material-symbols-outlined text-[16px]">restart_alt</span>}
                >
                  {t('settings.computerUse.pythonPathAuto')}
                </Button>
              )}
            </div>
            <p className="text-xs text-[var(--color-text-tertiary)]">
              {pythonPathMessage ?? t('settings.computerUse.pythonPathHint')}
            </p>
          </div>

          {/* macOS Permissions — only shown on macOS (darwin) */}
          {envReady && status.platform === 'darwin' && (
            <>
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
              {(accessibilityNeedsAttention || screenRecordingNeedsAttention) && (
                <div className="flex flex-col gap-2 px-4 py-3 rounded-[var(--radius-lg)] border border-[var(--color-warning)] bg-[var(--color-warning-container)]">
                  <p className="text-xs text-[var(--color-on-warning-container)]">{t('settings.computerUse.permRestartHint')}</p>
                  <div className="flex gap-2">
                    {accessibilityNeedsAttention && (
                      <Button
                        variant="secondary"
                        size="base"
                        onClick={() => openSystemSettings('Privacy_Accessibility')}
                        icon={<span className="material-symbols-outlined text-[14px]">open_in_new</span>}
                      >
                        {t('settings.computerUse.openAccessibility')}
                      </Button>
                    )}
                    {screenRecordingNeedsAttention && (
                      <Button
                        variant="secondary"
                        size="base"
                        onClick={() => openSystemSettings('Privacy_ScreenCapture')}
                        icon={<span className="material-symbols-outlined text-[14px]">open_in_new</span>}
                      >
                        {t('settings.computerUse.openScreenRecording')}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {allReady && (status.platform !== 'darwin' || (status.permissions.accessibility && screenRecordingReady)) && (
            <div className="px-4 py-3 rounded-[var(--radius-lg)] border border-[var(--color-success)] bg-[var(--color-success-container)] text-sm text-[var(--color-on-success-container)] flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: "'FILL' 1" }}>verified</span>
              {t('settings.computerUse.allReady')}
            </div>
          )}

          {setupResult && (
            <div className={`rounded-[var(--radius-lg)] border p-4 space-y-2 ${setupResult.success ? 'border-[var(--color-success)] bg-[var(--color-success-container)]' : 'border-[var(--color-error)] bg-[var(--color-error-container)]'}`}>
              <div className={`text-sm font-medium ${setupResult.success ? 'text-[var(--color-on-success-container)]' : 'text-[var(--color-on-error-container)]'}`}>
                {setupResult.success ? t('settings.computerUse.setupSuccess') : t('settings.computerUse.setupFail')}
              </div>
              {setupResult.steps.map((step, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                  <StatusIcon ok={step.ok} />
                  <span>{step.message}</span>
                </div>
              ))}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-3">
            {!status.python.installed && (
              <Button
                variant="primary"
                size="lg"
                onClick={() => openExternalUrl(pythonDownloadUrl)}
                icon={<span className="material-symbols-outlined text-[18px]">open_in_new</span>}
              >
                {t('settings.computerUse.downloadPython')}
              </Button>
            )}
            {!envReady && status.python.installed && (
              <Button
                variant="primary"
                size="lg"
                onClick={handleSetup}
                loading={setupRunning}
                icon={<span className="material-symbols-outlined text-[18px]">download</span>}
              >
                {setupRunning ? t('settings.computerUse.setupRunning') : t('settings.computerUse.setupBtn')}
              </Button>
            )}
            <Button
              variant="secondary"
              size="lg"
              onClick={fetchStatus}
              icon={<span className="material-symbols-outlined text-[18px]">refresh</span>}
            >
              {t('settings.computerUse.recheckBtn')}
            </Button>
          </div>

        </>
      ) : null}
      </div>
      {enableDialog}
    </>
  )
}

// ============================================================================
// Native (cu-helper) Codex-style page — macOS only, no Python.
// ============================================================================

type Translate = ReturnType<typeof useTranslation>

/** macOS OS-permission status row (辅助功能 / 屏幕录制): a refined row with a
 *  status dot (granted=emerald, needed=amber, checking=neutral) + label + state,
 *  built to live inside a divide-y group rather than as a standalone boxy card. */
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
  const dotClass = failed
    ? 'bg-[var(--color-error)]'
    : granted
    ? 'bg-[var(--color-success)]'
    : needed
      ? 'bg-[var(--color-warning)]'
      : 'bg-[var(--color-text-tertiary)]'
  // Status colors ride the semantic tokens so they follow [data-theme]
  // (stock emerald/amber shades are fixed colors — see paletteEscapes.test.ts).
  const detailClass = failed
    ? 'text-[var(--color-error)]'
    : granted
    ? 'text-[var(--color-success)]'
    : needed
      ? 'text-[var(--color-warning)]'
      : 'text-[var(--color-text-tertiary)]'
  return (
    <div className="flex items-center gap-3 py-2.5">
      <span className="relative flex h-2 w-2 flex-shrink-0 items-center justify-center" aria-hidden>
        <span className={`h-2 w-2 rounded-full ${dotClass} ${granted ? 'shadow-[0_0_0_3px_rgba(16,185,129,0.15)]' : needed ? 'shadow-[0_0_0_3px_rgba(245,158,11,0.15)]' : ''}`} />
        {needed && (
          <span className="absolute h-2 w-2 animate-ping rounded-full bg-[var(--color-warning)] opacity-60" />
        )}
      </span>
      <span className="flex-1 min-w-0 text-sm font-medium text-[var(--color-text-primary)]">
        {label}
      </span>
      <span className={`text-xs font-medium ${detailClass}`}>{detail}</span>
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
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight text-[var(--color-text-primary)]">
          {t('settings.computerUse.controlTitle')}
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-text-secondary)]">
          {t('settings.computerUse.controlSubtitle')}
        </p>
      </div>
      <Switch
        checked={enabled}
        onChange={onToggleEnabled}
        label={t('settings.computerUse.enabledToggle')}
        size="sm"
      />
    </div>
  )
  const configErrorNotice = configError ? (
    <div className="px-4 py-3 rounded-[var(--radius-lg)] border border-[var(--color-error)] bg-[var(--color-error-container)] text-sm text-[var(--color-on-error-container)]">
      {configError}
    </div>
  ) : null

  if (statusError) {
    return (
      <div className="max-w-2xl space-y-5">
        {header}
        {configErrorNotice}
        <ErrorState
          size="lg"
          title="Failed to check status."
          retryLabel={t('common.retry')}
          onRetry={onRecheck}
          tone="strong"
        />
      </div>
    )
  }

  if (!status.cuHelper.available) {
    return (
      <div className="max-w-2xl space-y-5">
        {header}
        {configErrorNotice}
        <ErrorState
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
    <div className="max-w-2xl space-y-10">
      {header}
      {configErrorNotice}

      {/* ─── 控制 (Control) ─── */}
      <section className="space-y-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
          {t('settings.computerUse.sectionControl')}
        </h3>

        {/* One elevated surface for the OS permissions required by the master
            toggle in the page header. */}
        <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          {/* OS-permission group */}
          <div className="px-4 py-4">
            <div className="text-sm font-semibold text-[var(--color-text-primary)]">
              {t('settings.computerUse.osPermTitle')}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-tertiary)]">
              {t('settings.computerUse.osPermHint')}
            </p>
            <div className="mt-2 divide-y divide-[var(--color-border)]">
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
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={onOpenCard}
                disabled={cardOpening}
                className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-accent)] transition hover:bg-[var(--color-surface-hover)] active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100"
              >
                <span className="material-symbols-outlined text-[16px]">
                  {cardOpening ? 'hourglass_empty' : 'shield_person'}
                </span>
                {cardOpening ? t('settings.computerUse.openingCard') : t('settings.computerUse.openCard')}
              </button>
              <button
                onClick={onRecheck}
                className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] active:scale-[0.98]"
              >
                <span className="material-symbols-outlined text-[16px]">refresh</span>
                {t('settings.computerUse.recheckBtn')}
              </button>
            </div>
            {cardError && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--color-error)]">
                <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: "'FILL' 1" }}>
                  error
                </span>
                {cardError}
              </p>
            )}
          </div>
        </div>
      </section>

    </div>
  )
}
