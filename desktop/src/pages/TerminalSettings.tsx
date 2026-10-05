import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type WheelEvent } from 'react'
import { ChevronDown, CircleAlert, Eraser, ExternalLink, FolderOpen, Info, Monitor, Plus, RotateCcw, SquareTerminal, X } from 'lucide-react'
import { useTranslation, type TranslationKey } from '../i18n'
import { terminalApi } from '../api/terminal'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { readTerminalPalette, readTerminalFontFamily } from '../lib/terminalTheme'
import { Dropdown } from '@/components/ui/Dropdown'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { IconButton, type IconButtonSurface } from '@/components/ui/IconButton'
import { EmptyState } from '@/components/ui/EmptyState'
import { StatusDot, type Tone } from '@/components/ui/Badge'
import {
  SettingsBlock,
  SettingsGroup,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsSection'
import type { DesktopTerminalStartupShell } from '../types/settings'
import { getDesktopHost } from '../lib/desktopHost'
import {
  attachTerminalRuntime,
  createLocalTerminalRuntimeId,
  destroyTerminalRuntime,
  getTerminalRuntime,
  isTerminalRuntimeCurrent,
  subscribeTerminalRuntime,
  updateTerminalRuntime,
  type TerminalRuntime,
  type TerminalStatus,
} from '../lib/terminalRuntime'

const STATUS_LABEL_KEYS: Record<TerminalStatus, TranslationKey> = {
  idle: 'settings.terminal.status.idle',
  starting: 'settings.terminal.status.starting',
  running: 'settings.terminal.status.running',
  exited: 'settings.terminal.status.exited',
  error: 'settings.terminal.status.error',
  unavailable: 'settings.terminal.status.unavailable',
}

function findScrollableAncestor(element: HTMLElement, deltaY: number): HTMLElement | null {
  let parent = element.parentElement
  while (parent) {
    const style = window.getComputedStyle(parent)
    const canScrollY = style.overflowY === 'auto' || style.overflowY === 'scroll'
    if (canScrollY && parent.scrollHeight > parent.clientHeight) {
      const maxScrollTop = parent.scrollHeight - parent.clientHeight
      const canMove = deltaY < 0 ? parent.scrollTop > 0 : parent.scrollTop < maxScrollTop
      if (canMove) return parent
    }
    parent = parent.parentElement
  }
  return null
}

type TerminalSettingsProps = {
  active?: boolean
  cwd?: string
  onNewTerminal?: () => void
  onOpenInTab?: () => void
  onClose?: () => void
  testId?: string
  workspace?: boolean
  docked?: boolean
  compactHeader?: boolean
  showPreferences?: boolean
  runtimeId?: string
  preserveOnUnmount?: boolean
  /**
   * Skip the implicit spawn on first mount, for a host that restores a terminal
   * from disk. A restored shell must come back stopped and be started by the
   * user — otherwise reopening the app silently spawns one process per terminal
   * the user happened to have open when they quit.
   */
  autoStart?: boolean
}

export function TerminalSettings({
  active = true,
  cwd,
  onNewTerminal,
  onOpenInTab,
  onClose,
  testId = 'settings-terminal-host',
  workspace = false,
  docked = false,
  compactHeader = false,
  showPreferences = false,
  runtimeId,
  preserveOnUnmount = false,
  autoStart = true,
}: TerminalSettingsProps = {}) {
  const t = useTranslation()
  const theme = useUIStore((state) => state.theme)
  const desktopTerminal = useSettingsStore((state) => state.desktopTerminal)
  const setDesktopTerminal = useSettingsStore((state) => state.setDesktopTerminal)
  const hostRef = useRef<HTMLDivElement | null>(null)
  // Read through a ref so flipping `autoStart` later (the user pressing Start)
  // does not re-run the lifecycle effect and spawn a second shell.
  const autoStartRef = useRef(autoStart)
  autoStartRef.current = autoStart
  const lifecycleVersionRef = useRef(0)
  const localRuntimeIdRef = useRef<string | null>(null)
  if (!localRuntimeIdRef.current) {
    localRuntimeIdRef.current = runtimeId ?? createLocalTerminalRuntimeId()
  }
  const effectiveRuntimeId = runtimeId ?? localRuntimeIdRef.current
  const runtimeRef = useRef<TerminalRuntime | null>(null)
  if (!runtimeRef.current || runtimeRef.current.id !== effectiveRuntimeId) {
    runtimeRef.current = getTerminalRuntime(effectiveRuntimeId, terminalApi.isAvailable() ? 'idle' : 'unavailable')
  }
  const runtime = runtimeRef.current
  const [, forceRuntimeUpdate] = useState(0)
  const status = runtime.status
  const error = runtime.error
  const shellInfo = runtime.shellInfo
  const [startupShell, setStartupShell] = useState<DesktopTerminalStartupShell>(desktopTerminal?.startupShell ?? 'system')
  const [customShellPath, setCustomShellPath] = useState(desktopTerminal?.customShellPath ?? '')
  const [preferencesError, setPreferencesError] = useState<string | null>(null)
  const [preferencesSaved, setPreferencesSaved] = useState(false)
  const [preferencesSaving, setPreferencesSaving] = useState(false)
  const isWindows = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || navigator.userAgent)

  useEffect(() => {
    return subscribeTerminalRuntime(runtime, () => forceRuntimeUpdate((value) => value + 1))
  }, [runtime])

  useEffect(() => {
    setStartupShell(desktopTerminal?.startupShell ?? 'system')
    setCustomShellPath(desktopTerminal?.customShellPath ?? '')
  }, [desktopTerminal])

  useEffect(() => {
    if (!preferencesSaved) return
    const timer = window.setTimeout(() => setPreferencesSaved(false), 2500)
    return () => window.clearTimeout(timer)
  }, [preferencesSaved])

  const shellItems = useMemo(() => [
    {
      value: 'system' as const,
      label: t('settings.terminal.shell.system'),
      description: t('settings.terminal.shell.systemDesc'),
    },
    {
      value: 'pwsh' as const,
      label: t('settings.terminal.shell.pwsh'),
      description: t('settings.terminal.shell.pwshDesc'),
    },
    {
      value: 'powershell' as const,
      label: t('settings.terminal.shell.powershell'),
      description: t('settings.terminal.shell.powershellDesc'),
    },
    {
      value: 'cmd' as const,
      label: t('settings.terminal.shell.cmd'),
      description: t('settings.terminal.shell.cmdDesc'),
    },
    {
      value: 'custom' as const,
      label: t('settings.terminal.shell.custom'),
      description: t('settings.terminal.shell.customDesc'),
    },
  ], [t])

  const resizeSession = useCallback(() => {
    // A hidden host measures as 0x0, and fitting against that pushes a 2x1
    // SIGWINCH to the PTY, reflowing whatever TUI is running inside it. The
    // bottom dock stays mounted while hidden precisely so the terminal keeps
    // its geometry, so this guard is what makes that safe.
    const host = hostRef.current
    if (host && (host.clientWidth === 0 || host.clientHeight === 0)) return
    const terminal = runtime.terminal
    const fit = runtime.fit
    const sessionId = runtime.nativeSessionId
    if (!terminal || !fit) return

    fit.fit()
    if (sessionId) {
      void terminalApi.resize(sessionId, terminal.cols, terminal.rows).catch(() => {})
    }
  }, [runtime])

  const startTerminal = useCallback(() => {
    if (!terminalApi.isAvailable()) {
      updateTerminalRuntime(runtime, { status: 'unavailable' })
      return Promise.resolve()
    }

    if (runtime.startPromise) {
      const host = hostRef.current
      void runtime.startPromise.then(() => {
        if (!host || !isTerminalRuntimeCurrent(runtime) || !runtime.terminal) return
        attachTerminalRuntime(runtime, host)
        resizeSession()
      })
      return runtime.startPromise
    }

    const host = hostRef.current
    if (!host) return Promise.resolve()

    const requestId = crypto.randomUUID()
    let exitedDuringStart = false
    const startToken = runtime.startToken + 1
    runtime.startToken = startToken
    const isCurrentStart = () => isTerminalRuntimeCurrent(runtime) && runtime.startToken === startToken

    const startPromise = Promise.resolve().then(async () => {
      if (!isCurrentStart()) return
      updateTerminalRuntime(runtime, { error: null, status: 'starting', shellInfo: null, title: '' })

      const existing = runtime.nativeSessionId
      if (existing) {
        await terminalApi.kill(existing).catch(() => {})
        if (!isCurrentStart()) return
        runtime.nativeSessionId = null
      }
      runtime.dataDisposable?.dispose()
      runtime.dataDisposable = null
      runtime.unlisteners.forEach((unlisten) => unlisten())
      runtime.unlisteners = []

      runtime.terminal?.dispose()
      runtime.terminal = null
      runtime.fit = null
      host.innerHTML = ''

      let TerminalModule: typeof import('@xterm/xterm')
      let WebLinksAddonModule: typeof import('@xterm/addon-web-links')
      let FitAddonModule: typeof import('@xterm/addon-fit')
      try {
        [TerminalModule, FitAddonModule, WebLinksAddonModule] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
          import('@xterm/addon-web-links'),
        ])
      } catch (err) {
        if (isCurrentStart()) {
          updateTerminalRuntime(runtime, {
            error: err instanceof Error ? err.message : String(err),
            status: 'error',
          })
        }
        return
      }
      if (!isCurrentStart()) return

      let terminal: import('@xterm/xterm').Terminal | null = null
      let fit: import('@xterm/addon-fit').FitAddon | null = null
      let outputUnlisten: (() => void) | null = null
      let exitUnlisten: (() => void) | null = null

      try {
        terminal = new TerminalModule.Terminal({
          cursorBlink: true,
          convertEol: false,
          fontFamily: readTerminalFontFamily(),
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.2,
          cursorStyle: 'bar',
          // xterm preserves scrollback position while writing; erasing the
          // display must not override a user reading earlier output either.
          scrollOnEraseInDisplay: false,
          scrollback: 4000,
          theme: readTerminalPalette(),
        })
        fit = new FitAddonModule.FitAddon()
        const activeTerminal = terminal
        const activeFit = fit
        activeTerminal.loadAddon(activeFit)
        activeTerminal.loadAddon(new WebLinksAddonModule.WebLinksAddon((_event, uri) => {
          // Use the same external-open boundary as other desktop surfaces.
          if (/^https?:\/\//i.test(uri)) void getDesktopHost().shell.open(uri).catch(() => {})
        }))
        activeTerminal.onTitleChange((title) => {
          if (isCurrentStart()) updateTerminalRuntime(runtime, { title })
        })
        activeTerminal.open(host)
        if (!isCurrentStart()) {
          activeTerminal.dispose()
          return
        }
        updateTerminalRuntime(runtime, { terminal: activeTerminal, fit: activeFit })
        activeFit.fit()

        outputUnlisten = await terminalApi.onOutput((payload) => {
          if (!isCurrentStart()) return
          if (payload.requestId === requestId || payload.session_id === runtime.nativeSessionId) {
            activeTerminal.write(payload.data)
          }
        })
        exitUnlisten = await terminalApi.onExit((payload) => {
          if (!isCurrentStart()) return
          if (payload.requestId !== requestId && payload.session_id !== runtime.nativeSessionId) return
          exitedDuringStart = true
          updateTerminalRuntime(runtime, { status: 'exited' })
          const signal = payload.signal ? `, ${payload.signal}` : ''
          activeTerminal.writeln(`\r\n[process exited: ${payload.code}${signal}]`)
          updateTerminalRuntime(runtime, { nativeSessionId: null })
        })
        if (!isCurrentStart()) {
          outputUnlisten()
          exitUnlisten()
          activeTerminal.dispose()
          return
        }
        runtime.unlisteners = [outputUnlisten, exitUnlisten]

        runtime.dataDisposable = terminal.onData((data) => {
          const sessionId = runtime.nativeSessionId
          if (sessionId) {
            void terminalApi.write(sessionId, data).catch((err) => {
              updateTerminalRuntime(runtime, {
                error: err instanceof Error ? err.message : String(err),
                status: 'error',
              })
            })
          }
        })

        const result = await terminalApi.spawn({
          requestId,
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
          ...(cwd ? { cwd } : {}),
        })
        if (!isCurrentStart()) {
          await terminalApi.kill(result.session_id).catch(() => {})
          outputUnlisten()
          exitUnlisten()
          activeTerminal.dispose()
          return
        }
        updateTerminalRuntime(runtime, {
          nativeSessionId: exitedDuringStart ? null : result.session_id,
          shellInfo: { shell: result.shell, cwd: result.cwd },
          status: exitedDuringStart ? 'exited' : 'running',
        })
        resizeSession()
      } catch (err) {
        outputUnlisten?.()
        exitUnlisten?.()
        terminal?.dispose()
        if (isCurrentStart()) {
          updateTerminalRuntime(runtime, {
            terminal: null,
            fit: null,
            error: err instanceof Error ? err.message : String(err),
            status: 'error',
          })
        }
      }
    })
    runtime.startPromise = startPromise
    void startPromise.finally(() => {
      if (runtime.startPromise === startPromise) {
        runtime.startPromise = null
      }
    }).catch(() => {})
    return startPromise
  }, [cwd, resizeSession, runtime])

  useEffect(() => {
    const restart = () => {
      void startTerminal().then(() => {
        const host = hostRef.current
        if (host && host.clientWidth > 0 && host.clientHeight > 0) runtime.terminal?.focus()
      })
    }
    updateTerminalRuntime(runtime, { restart })
    return () => {
      if (runtime.restart === restart) updateTerminalRuntime(runtime, { restart: null })
    }
  }, [runtime, startTerminal])

  useEffect(() => {
    lifecycleVersionRef.current += 1
    const lifecycleVersion = lifecycleVersionRef.current
    if (!terminalApi.isAvailable()) return
    if (runtime.terminal) {
      if (hostRef.current) {
        attachTerminalRuntime(runtime, hostRef.current)
      }
      resizeSession()
    } else if (runtime.startPromise) {
      void runtime.startPromise.then(() => {
        if (!hostRef.current || !isTerminalRuntimeCurrent(runtime) || !runtime.terminal) return
        attachTerminalRuntime(runtime, hostRef.current)
        resizeSession()
      })
    } else if (autoStartRef.current) {
      void startTerminal()
    }

    const observer = new ResizeObserver(() => resizeSession())
    if (hostRef.current) observer.observe(hostRef.current)

    return () => {
      observer.disconnect()
      if (!preserveOnUnmount) {
        // StrictMode replays effects once during initial mount. Let the replay
        // retain this runtime instead of leaving the component with a stale
        // object that can never start or restart.
        queueMicrotask(() => {
          if (lifecycleVersionRef.current !== lifecycleVersion) return
          destroyTerminalRuntime(runtime.id)
        })
      }
    }
  }, [preserveOnUnmount, resizeSession, runtime, startTerminal])

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => resizeSession())
    }
  }, [active, resizeSession])

  // Repaint an already-running terminal when the app theme changes. The
  // runtime outlives this component, so a terminal started under one theme
  // would otherwise keep that palette for the rest of the session.
  useEffect(() => {
    const terminal = runtime.terminal
    if (!terminal) return
    terminal.options.theme = readTerminalPalette()
    terminal.options.fontFamily = readTerminalFontFamily()
    resizeSession()
  }, [runtime, theme, resizeSession])

  useEffect(() => {
    const fonts = document.fonts
    if (!fonts) return
    fonts.addEventListener('loadingdone', resizeSession)
    return () => fonts.removeEventListener('loadingdone', resizeSession)
  }, [resizeSession])

  const clearTerminal = () => {
    runtime.terminal?.clear()
  }

  const handleTerminalWheelCapture = useCallback((event: WheelEvent<HTMLDivElement>) => {
    const host = hostRef.current
    if (!host || host.contains(document.activeElement)) return

    const scroller = findScrollableAncestor(event.currentTarget, event.deltaY)
    if (!scroller) return

    event.preventDefault()
    event.stopPropagation()
    scroller.scrollBy({ top: event.deltaY, left: event.deltaX })
  }, [])

  const handleTerminalKeyDownCapture = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const terminal = runtime.terminal
    if (!terminal) return

    if (isTerminalCopyShortcut(event, terminal)) {
      event.preventDefault()
      event.stopPropagation()
      void copyTerminalSelection(terminal).catch(() => {})
      return
    }

    if (isTerminalPasteShortcut(event)) {
      event.preventDefault()
      event.stopPropagation()
      void pasteClipboardIntoTerminal(terminal).catch(() => {})
    }
  }, [runtime])

  const savePreferences = async () => {
    setPreferencesError(null)
    setPreferencesSaved(false)

    const trimmedPath = customShellPath.trim()
    if (startupShell === 'custom') {
      if (!trimmedPath) {
        setPreferencesError(t('settings.terminal.customPathRequired'))
        return
      }
      if (!/^[A-Za-z]:[\\/]/.test(trimmedPath)) {
        setPreferencesError(t('settings.terminal.customPathAbsolute'))
        return
      }
    }

    setPreferencesSaving(true)
    try {
      await setDesktopTerminal({
        startupShell,
        customShellPath: trimmedPath,
      })
      setPreferencesSaved(true)
    } catch (err) {
      setPreferencesError(err instanceof Error ? err.message : String(err))
    } finally {
      setPreferencesSaving(false)
    }
  }

  // The terminal panel is only drawn when there is a session behind it; the
  // terminal palette follows its own tokens, so anything sitting on it has to
  // switch together.
  const hasTerminalPanel = status !== 'unavailable'
  // The Settings → Terminal page. The same component also backs the workspace
  // terminal tab (`workspace`) and the docked bottom panel (`docked`), which own
  // their own chrome, so the page header and width only apply here.
  const settingsPage = showPreferences && !workspace && !docked
  const terminalHeaderTitleClass = hasTerminalPanel
    ? 'text-[var(--color-terminal-fg)]'
    : 'text-[var(--color-text-primary)]'
  const terminalHeaderMetaClass = hasTerminalPanel
    ? 'text-[var(--color-terminal-muted)]'
    : 'text-[var(--color-text-tertiary)]'
  const terminalHeaderSurface: IconButtonSurface = hasTerminalPanel ? 'terminal' : 'default'
  const actionIconSize = docked ? 14 : 16
  const selectedShell = shellItems.find((item) => item.value === startupShell)

  return (
    <div className={
      docked
        ? 'flex h-full min-h-0 flex-col overflow-hidden bg-[var(--color-surface-container-lowest)]'
        : workspace
          ? 'flex h-full min-h-0 flex-col overflow-hidden bg-[var(--color-surface)] px-5 py-4'
          : settingsPage
            // Settings.tsx owns the page frame (width, gutters); this is just the column.
            ? 'flex min-w-0 flex-col'
            : 'flex h-full min-h-[min(720px,calc(100vh-8rem))] flex-col overflow-hidden'
    }>
      {settingsPage && (
        <SettingsPageHeader
          title={t('settings.terminal.title')}
          description={t('settings.terminal.description')}
        />
      )}

      {error && (
        <div className={`${settingsPage ? 'mt-6' : 'mb-3'} flex items-start gap-2 rounded-[var(--radius-md)] bg-[var(--color-error-container)] px-3 py-2 text-xs leading-[1.5] text-[var(--color-on-error-container)]`}>
          <CircleAlert size={14} strokeWidth={1.75} aria-hidden="true" className="mt-px shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      {showPreferences && isWindows && (
        <>
          <SettingsSection
            title={t('settings.terminal.preferencesTitle')}
            description={t('settings.terminal.preferencesBody')}
          >
            <SettingsGroup>
              <SettingsRow
                title={t('settings.terminal.startupShell')}
                description={selectedShell?.description}
                layout="inline"
              >
                <Dropdown<DesktopTerminalStartupShell>
                  items={shellItems}
                  value={startupShell}
                  onChange={(value) => {
                    setStartupShell(value)
                    setPreferencesError(null)
                    setPreferencesSaved(false)
                  }}
                  width={300}
                  align="right"
                  trigger={
                    // `flex-1` on the label, not `justify-between`: Button pins
                    // `justify-center`, and a className override of it would win
                    // or lose on stylesheet order rather than on class order.
                    <Button variant="secondary" size="base" className="w-[220px]">
                      <span className="flex-1 truncate text-left font-normal text-[var(--color-text-primary)]">
                        {selectedShell?.label ?? startupShell}
                      </span>
                      <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
                    </Button>
                  }
                />
              </SettingsRow>

              {startupShell === 'custom' && (
                <SettingsBlock>
                  <Input
                    label={t('settings.terminal.customPath')}
                    placeholder={t('settings.terminal.customPathPlaceholder')}
                    value={customShellPath}
                    size="md"
                    className="font-mono"
                    onChange={(event) => {
                      setCustomShellPath(event.target.value)
                      setPreferencesError(null)
                      setPreferencesSaved(false)
                    }}
                    error={preferencesError ?? undefined}
                  />
                </SettingsBlock>
              )}

              <SettingsBlock className="flex min-h-[52px] flex-wrap items-center justify-end gap-3">
                {preferencesError && startupShell !== 'custom' && (
                  <p className="mr-auto text-xs text-[var(--color-error)]">{preferencesError}</p>
                )}
                {preferencesSaved && (
                  <span className="text-xs text-[var(--color-text-tertiary)]">
                    {t('settings.terminal.saveShellSuccess')}
                  </span>
                )}
                <Button
                  type="button"
                  size="base"
                  loading={preferencesSaving}
                  onClick={() => void savePreferences()}
                >
                  {t('settings.terminal.saveShell')}
                </Button>
              </SettingsBlock>
            </SettingsGroup>
          </SettingsSection>
          <BashPathSettings isTauri={terminalApi.isAvailable()} />
        </>
      )}

      {/* The workspace already owns a tab strip; only standalone terminals need a frame. */}
      <div
        className={[
          'flex flex-col overflow-hidden',
          settingsPage ? 'mt-7 h-[min(560px,calc(100vh-14rem))] min-h-[320px]' : 'min-h-0 flex-1',
          docked ? '' : `rounded-[var(--radius-lg)] border ${hasTerminalPanel ? 'border-[var(--color-terminal-border)]' : 'border-[var(--color-border)]'}`,
          hasTerminalPanel ? 'bg-[var(--color-terminal-bg)]' : 'bg-[var(--color-surface-container-lowest)]',
        ].join(' ')}
      >
        {!compactHeader && <div
          data-testid="settings-terminal-toolbar"
          className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-1.5 ${
            docked ? 'min-h-9' : 'min-h-10'
          } ${
            hasTerminalPanel
              ? 'border-[var(--color-terminal-border)] bg-[var(--color-terminal-header)]'
              : 'border-[var(--color-border)] bg-[var(--color-surface-container-low)]'
          }`}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {!docked && (
              <SquareTerminal size={14} strokeWidth={1.75} aria-hidden="true" className={`shrink-0 ${terminalHeaderMetaClass}`} />
            )}
            {/* The settings page names the terminal in its page header already. */}
            {!docked && !settingsPage && <h2 className={`shrink-0 text-[13px] font-medium ${terminalHeaderTitleClass}`}>
              {t('settings.terminal.title')}
            </h2>}
            {shellInfo && (
              <div className={`flex min-w-0 items-center gap-1.5 font-mono text-[11px] ${terminalHeaderMetaClass}`}>
                <span className="min-w-0 truncate">{shellInfo.cwd}</span>
                <span className="shrink-0">·</span>
                <span className="shrink-0">{shellInfo.shell}</span>
              </div>
            )}
            <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs ${terminalHeaderMetaClass}`}>
              <StatusDot tone={STATUS_TONE[status]} pulse={status === 'running'} />
              {t(STATUS_LABEL_KEYS[status])}
            </span>
            {/* Info lives on the left: its tooltip is anchored to the icon's
                left edge and opens down-right, so from here it always lands
                inside the panel instead of being clipped by the right edge.
                The settings page shows the same guidance as its description. */}
            {!settingsPage && (
              <span className="inline-flex shrink-0 items-center">
                <TerminalHelpHint compact={docked} surface={terminalHeaderSurface} />
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            {onOpenInTab && (
              <IconButton
                icon={<ExternalLink size={actionIconSize} strokeWidth={1.75} aria-hidden="true" />}
                label={t('terminal.openInTab')}
                size={docked ? 'sm' : 'md'}
                tone="muted"
                surface={terminalHeaderSurface}
                onClick={onOpenInTab}
              />
            )}
            {onNewTerminal && (
              <IconButton
                icon={<Plus size={actionIconSize} strokeWidth={1.75} aria-hidden="true" />}
                label={t('terminal.newTab')}
                size={docked ? 'sm' : 'md'}
                tone="muted"
                surface={terminalHeaderSurface}
                onClick={onNewTerminal}
              />
            )}
            <IconButton
              icon={<Eraser size={actionIconSize} strokeWidth={1.75} aria-hidden="true" />}
              label={t('settings.terminal.clear')}
              size={docked ? 'sm' : 'md'}
              tone="muted"
              surface={terminalHeaderSurface}
              disabled={!runtime.terminal}
              onClick={clearTerminal}
            />
            <IconButton
              icon={<RotateCcw size={actionIconSize} strokeWidth={1.75} aria-hidden="true" />}
              label={t('settings.terminal.restart')}
              size={docked ? 'sm' : 'md'}
              tone="muted"
              surface={terminalHeaderSurface}
              disabled={status === 'starting'}
              onClick={() => void startTerminal()}
            />
            {onClose && (
              <IconButton
                icon={<X size={actionIconSize} strokeWidth={1.75} aria-hidden="true" />}
                label={t('terminal.closePanel')}
                showTooltip={false}
                size={docked ? 'sm' : 'md'}
                tone="muted"
                surface={terminalHeaderSurface}
                onClick={onClose}
              />
            )}
          </div>
        </div>}

        {compactHeader && status === 'starting' && (
          <div role="status" className="px-3 py-1 text-xs text-[var(--color-terminal-muted)]">
            {t(STATUS_LABEL_KEYS[status])}
          </div>
        )}

        {status === 'unavailable' ? (
          <EmptyState
            className="flex-1"
            size="md"
            variant="plain"
            icon={<Monitor size={18} strokeWidth={1.75} aria-hidden="true" />}
            title={t('settings.terminal.unavailableTitle')}
            description={t('settings.terminal.unavailableBody')}
          />
        ) : (
          <div
            data-testid="settings-terminal-frame"
            onKeyDownCapture={handleTerminalKeyDownCapture}
            onWheelCapture={handleTerminalWheelCapture}
            className="min-h-0 flex-1 overflow-hidden"
          >
            <div
              ref={hostRef}
              data-testid={testId}
              className="settings-terminal-host h-full w-full overflow-hidden px-2.5 pb-2.5 pt-2"
            />
          </div>
        )}
      </div>
    </div>
  )
}

type TerminalKeyboardEvent = Pick<KeyboardEvent<HTMLElement>, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>
type ClipboardTerminal = {
  focus(): void
  getSelection(): string
  hasSelection(): boolean
  paste(data: string): void
}

function isApplePlatform() {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform)
}

function isWindowsPlatform() {
  if (typeof navigator === 'undefined') return false
  return /Win/i.test(navigator.platform || navigator.userAgent)
}

function normalizedKey(event: TerminalKeyboardEvent) {
  return event.key.toLowerCase()
}

function isTerminalCopyShortcut(event: TerminalKeyboardEvent, terminal: ClipboardTerminal) {
  if (event.altKey || !terminal.hasSelection()) return false

  const key = normalizedKey(event)
  if (isApplePlatform()) {
    return event.metaKey && !event.ctrlKey && key === 'c'
  }

  if (key === 'insert') {
    return event.ctrlKey && !event.shiftKey && !event.metaKey
  }

  if (isWindowsPlatform() && event.ctrlKey && !event.metaKey && !event.shiftKey && key === 'c') {
    return true
  }

  return event.ctrlKey && !event.metaKey && event.shiftKey && key === 'c'
}

function isTerminalPasteShortcut(event: TerminalKeyboardEvent) {
  if (event.altKey) return false

  const key = normalizedKey(event)
  if (isApplePlatform()) {
    return event.metaKey && !event.ctrlKey && key === 'v'
  }

  if (key === 'insert') {
    return event.shiftKey && !event.ctrlKey && !event.metaKey
  }

  if (isWindowsPlatform() && event.ctrlKey && !event.metaKey && !event.shiftKey && key === 'v') {
    return true
  }

  return event.ctrlKey && !event.metaKey && event.shiftKey && key === 'v'
}

async function copyTerminalSelection(terminal: ClipboardTerminal) {
  const text = terminal.getSelection()
  if (!text) return
  await getDesktopHost().clipboard.writeText(text)
  terminal.focus()
}

async function pasteClipboardIntoTerminal(terminal: ClipboardTerminal) {
  const text = await getDesktopHost().clipboard.readText()
  if (!text) return
  terminal.paste(text)
  terminal.focus()
}

function TerminalHelpHint({
  compact = false,
  surface = 'default',
}: { compact?: boolean; surface?: IconButtonSurface }) {
  const t = useTranslation()
  const tooltipId = useId()
  const [open, setOpen] = useState(false)

  return (
    <span className="group relative inline-flex shrink-0">
      {/* showTooltip=false: the sibling `role="tooltip"` span below is the tooltip.
          A native `title` would duplicate it and, per the a11y baseline, tooltips
          are wired with aria-describedby rather than becoming the accessible name. */}
      <IconButton
        icon={<Info size={compact ? 12 : 14} aria-hidden="true" strokeWidth={compact ? 2 : 1.75} />}
        label={t('settings.terminal.infoLabel')}
        showTooltip={false}
        size={compact ? 'xs' : 'sm'}
        shape="circle"
        tone="muted"
        surface={surface}
        aria-describedby={tooltipId}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false)
        }}
      />
      <span
        id={tooltipId}
        role="tooltip"
        className={`${open ? 'visible opacity-100' : 'invisible opacity-0'} absolute left-0 top-full z-[var(--z-tooltip)] mt-2 w-[min(340px,calc(100vw-3rem))] rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3 py-2 text-left text-xs leading-5 text-[var(--color-text-secondary)] shadow-[var(--shadow-dropdown)] transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100`}
      >
        {t('settings.terminal.description')}
      </span>
    </span>
  )
}

const STATUS_TONE: Record<TerminalStatus, Tone> = {
  running: 'success',
  error: 'danger',
  starting: 'info',
  idle: 'neutral',
  exited: 'neutral',
  unavailable: 'neutral',
}

function BashPathSettings({ isTauri }: { isTauri: boolean }) {
  const t = useTranslation()
  const [bashPath, setBashPath] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    if (!isTauri) return
    void terminalApi.getBashPath().then((path) => setBashPath(path)).catch(() => {})
  }, [isTauri])

  const handleSave = async () => {
    const trimmed = bashPath?.trim() || null
    setSaving(true)
    setInvalid(false)
    setSaved(false)
    try {
      await terminalApi.setBashPath(trimmed)
      setBashPath(trimmed)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setInvalid(true)
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    setSaving(true)
    setSaved(false)
    setInvalid(false)
    try {
      await terminalApi.setBashPath(null)
      setBashPath(null)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      // ignore
    } finally {
      setSaving(false)
    }
  }

  const handleBrowse = async () => {
    if (!isTauri) return
    const host = getDesktopHost()
    if (!host.capabilities.dialogs) return
    try {
      const selected = await host.dialogs.open({
        title: t('settings.terminal.bashPathLabel'),
        multiple: false,
        filters: [{
          name: 'Bash Executable',
          extensions: ['exe', '', 'bat', 'cmd', 'ps1'],
        }],
      })
      if (selected && typeof selected === 'string') {
        setBashPath(selected)
        setInvalid(false)
      }
    } catch {
      // user cancelled
    }
  }

  if (!isTauri) return null

  return (
    <SettingsSection
      title={t('settings.terminal.bashPathLabel')}
      description={t('settings.terminal.bashPathDescription')}
    >
      <SettingsGroup>
        <SettingsBlock>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="text"
              size="md"
              containerClassName="min-w-[200px] flex-1"
              className="font-mono"
              aria-label={t('settings.terminal.bashPathLabel')}
              value={bashPath || ''}
              onChange={(e) => { setBashPath(e.target.value); setInvalid(false); setSaved(false) }}
              placeholder={t('settings.terminal.bashPathLabel')}
            />
            <IconButton
              icon={<FolderOpen size={16} strokeWidth={1.75} aria-hidden="true" />}
              label={t('settings.terminal.bashPathBrowse')}
              showTooltip={false}
              size="md"
              tone="secondary"
              bordered
              onClick={handleBrowse}
            />
            <Button variant="primary" size="base" onClick={handleSave} disabled={saving}>
              {saved ? t('settings.terminal.bashPathSaved') : t('settings.terminal.bashPathSave')}
            </Button>
            <Button
              variant="secondary"
              size="base"
              onClick={handleReset}
              disabled={saving || bashPath === null}
            >
              {t('settings.terminal.bashPathReset')}
            </Button>
          </div>
          {invalid && (
            <p className="mt-2 text-xs text-[var(--color-error)]">
              {t('settings.terminal.bashPathInvalid')}
            </p>
          )}
        </SettingsBlock>
      </SettingsGroup>
    </SettingsSection>
  )
}
