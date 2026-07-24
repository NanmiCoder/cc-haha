import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type WheelEvent } from 'react'
import {
  Eraser,
  ExternalLink,
  Info,
  Plus,
  RotateCcw,
  SquareTerminal,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { ITheme } from '@xterm/xterm'
import { useTranslation, type TranslationKey } from '../i18n'
import { terminalApi } from '../api/terminal'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { Dropdown } from '../components/shared/Dropdown'
import { Input } from '../components/shared/Input'
import { Button } from '../components/shared/Button'
import type { DesktopTerminalStartupShell, ThemeMode } from '../types/settings'
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

function getTerminalTheme(theme: ThemeMode): ITheme {
  if (theme === 'dark') {
    return {
      background: '#121212',
      foreground: '#D7D2D0',
      cursor: '#F5F5F5',
      selectionBackground: '#4A4746',
      black: '#1F1F1F',
      red: '#FF6D67',
      green: '#7EF18A',
      yellow: '#F8C55F',
      blue: '#77A8FF',
      magenta: '#D699FF',
      cyan: '#61D6D6',
      white: '#D7D2D0',
      brightBlack: '#8F8683',
      brightRed: '#FF8A85',
      brightGreen: '#9FF7A7',
      brightYellow: '#FFDD7A',
      brightBlue: '#A6C5FF',
      brightMagenta: '#E3B8FF',
      brightCyan: '#8CEEEE',
      brightWhite: '#FFFFFF',
    }
  }

  const warm = theme === 'light'
  return {
    background: warm ? '#FBFAF6' : '#FFFFFF',
    foreground: warm ? '#2B2926' : '#242424',
    cursor: warm ? '#2B2926' : '#242424',
    selectionBackground: warm ? '#DDD9CF' : '#DDE8F7',
    black: '#242424',
    red: '#C94747',
    green: '#237B4B',
    yellow: '#8A6200',
    blue: '#2563EB',
    magenta: '#7C3AED',
    cyan: '#087F8C',
    white: '#6B6B6B',
    brightBlack: '#737373',
    brightRed: '#DC4C4C',
    brightGreen: '#16845B',
    brightYellow: '#9A6C00',
    brightBlue: '#1D67E8',
    brightMagenta: '#8B4BE8',
    brightCyan: '#057A87',
    brightWhite: '#171717',
  }
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
  showPreferences?: boolean
  runtimeId?: string
  preserveOnUnmount?: boolean
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
  showPreferences = false,
  runtimeId,
  preserveOnUnmount = false,
}: TerminalSettingsProps = {}) {
  const t = useTranslation()
  const desktopTerminal = useSettingsStore((state) => state.desktopTerminal)
  const setDesktopTerminal = useSettingsStore((state) => state.setDesktopTerminal)
  const theme = useUIStore((state) => state.theme)
  const themeRef = useRef(theme)
  themeRef.current = theme
  const hostRef = useRef<HTMLDivElement | null>(null)
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

    const startToken = runtime.startToken + 1
    runtime.startToken = startToken
    const isCurrentStart = () => isTerminalRuntimeCurrent(runtime) && runtime.startToken === startToken

    const startPromise = Promise.resolve().then(async () => {
      if (!isCurrentStart()) return
      updateTerminalRuntime(runtime, { error: null, status: 'starting', shellInfo: null })

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
      let FitAddonModule: typeof import('@xterm/addon-fit')
      try {
        [TerminalModule, FitAddonModule] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
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
          fontFamily: "var(--font-mono), 'SFMono-Regular', Consolas, monospace",
          fontSize: 12,
          lineHeight: 1.25,
          scrollback: 4000,
          theme: getTerminalTheme(themeRef.current),
        })
        fit = new FitAddonModule.FitAddon()
        const activeTerminal = terminal
        const activeFit = fit
        activeTerminal.loadAddon(activeFit)
        activeTerminal.open(host)
        if (!isCurrentStart()) {
          activeTerminal.dispose()
          return
        }
        updateTerminalRuntime(runtime, { terminal: activeTerminal, fit: activeFit })
        activeFit.fit()

        outputUnlisten = await terminalApi.onOutput((payload) => {
          if (payload.session_id === runtime.nativeSessionId) {
            activeTerminal.write(payload.data)
          }
        })
        exitUnlisten = await terminalApi.onExit((payload) => {
          if (payload.session_id !== runtime.nativeSessionId) return
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
          nativeSessionId: result.session_id,
          shellInfo: { shell: result.shell, cwd: result.cwd },
          status: 'running',
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
    } else {
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

  useEffect(() => {
    if (!runtime.terminal) return
    runtime.terminal.options.theme = getTerminalTheme(theme)
  }, [runtime, theme])

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

  return (
    <div className={`flex h-full flex-col overflow-hidden ${
      docked
        ? 'min-h-0 bg-[var(--color-surface-glass)] px-3 pb-2 backdrop-blur-xl'
        : workspace
          ? 'min-h-0 bg-[var(--color-surface)] px-5 py-4'
          : 'min-h-[min(720px,calc(100vh-8rem))]'
    }`}>
      <div
        data-testid="settings-terminal-toolbar"
        data-terminal-chrome="integrated"
        className={`${docked ? 'min-h-10 border-b border-[var(--color-border)]' : 'mb-2 min-h-10'} flex min-w-0 flex-wrap items-center gap-2`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            data-testid="terminal-toolbar-identity"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-surface-container)] text-[var(--color-text-secondary)]"
            aria-hidden="true"
          >
            <SquareTerminal className="h-4 w-4" strokeWidth={1.9} />
          </span>
          <h2 className={`${docked ? 'text-[13px]' : 'text-sm'} shrink-0 font-semibold text-[var(--color-text-primary)]`}>
            {t('settings.terminal.title')}
          </h2>
          <TerminalHelpHint compact={docked} />
          <StatusPill status={status} label={t(STATUS_LABEL_KEYS[status])} compact={docked} />
          {shellInfo && (
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--color-text-tertiary)]">
              <span className="shrink-0 font-mono">{shellInfo.shell}</span>
              <span className="shrink-0 text-[var(--color-border)]">/</span>
              <span className="min-w-0 truncate font-mono">{shellInfo.cwd}</span>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {onOpenInTab && (
            <TerminalToolbarAction
              icon={ExternalLink}
              label={t('terminal.openInTab')}
              onClick={onOpenInTab}
            />
          )}
          {onNewTerminal && (
            <TerminalToolbarAction
              icon={Plus}
              label={t('terminal.newTab')}
              onClick={onNewTerminal}
            />
          )}
          <TerminalToolbarAction
            icon={Eraser}
            label={t('settings.terminal.clear')}
            onClick={clearTerminal}
            disabled={!runtime.terminal}
          />
          <TerminalToolbarAction
            icon={RotateCcw}
            label={t('settings.terminal.restart')}
            onClick={() => void startTerminal()}
            disabled={status === 'starting'}
          />
          {onClose && (
            <TerminalToolbarAction
              icon={X}
              label={t('terminal.closePanel')}
              onClick={onClose}
            />
          )}
        </div>
      </div>
      {error && (
        <div className="mb-3 rounded-[var(--radius-md)] border border-[var(--color-error)]/20 bg-[var(--color-error)]/10 px-3 py-2 text-sm text-[var(--color-error)]">
          {error}
        </div>
      )}

      {showPreferences && isWindows && (
        <>
          <div className="mb-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4">
            <div className="flex flex-col gap-3">
              <div>
                <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                  {t('settings.terminal.preferencesTitle')}
                </h3>
                <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                  {t('settings.terminal.preferencesBody')}
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-[var(--color-text-primary)]">
                  {t('settings.terminal.startupShell')}
                </span>
                <Dropdown<DesktopTerminalStartupShell>
                  items={shellItems}
                  value={startupShell}
                  onChange={(value) => {
                    setStartupShell(value)
                    setPreferencesError(null)
                    setPreferencesSaved(false)
                  }}
                  width="100%"
                  trigger={
                    <button
                      type="button"
                      className="flex h-10 w-full items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text-primary)]"
                    >
                      <span>{shellItems.find((item) => item.value === startupShell)?.label ?? startupShell}</span>
                      <span className="material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)]">expand_more</span>
                    </button>
                  }
                />
              </div>

              {startupShell === 'custom' && (
                <Input
                  label={t('settings.terminal.customPath')}
                  placeholder={t('settings.terminal.customPathPlaceholder')}
                  value={customShellPath}
                  onChange={(event) => {
                    setCustomShellPath(event.target.value)
                    setPreferencesError(null)
                    setPreferencesSaved(false)
                  }}
                  error={preferencesError ?? undefined}
                />
              )}

              {preferencesError && startupShell !== 'custom' && (
                <p className="text-xs text-[var(--color-error)]">{preferencesError}</p>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  size="sm"
                  loading={preferencesSaving}
                  onClick={() => void savePreferences()}
                >
                  {t('settings.terminal.saveShell')}
                </Button>
                {preferencesSaved && (
                  <span className="text-xs text-[var(--color-text-secondary)]">
                    {t('settings.terminal.saveShellSuccess')}
                  </span>
                )}
              </div>
            </div>
          </div>
          <BashPathSettings isTauri={terminalApi.isAvailable()} />
        </>
      )}

      {status === 'unavailable' ? (
        <div className="flex flex-1 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-8 text-center">
          <div>
            <span className="material-symbols-outlined mb-3 block text-[32px] text-[var(--color-text-tertiary)]">
              desktop_windows
            </span>
            <p className="text-sm font-medium text-[var(--color-text-primary)]">
              {t('settings.terminal.unavailableTitle')}
            </p>
            <p className="mt-1 text-sm text-[var(--color-text-tertiary)]">
              {t('settings.terminal.unavailableBody')}
            </p>
          </div>
        </div>
      ) : (
        <div
          data-testid="settings-terminal-frame"
          onKeyDownCapture={handleTerminalKeyDownCapture}
          onWheelCapture={handleTerminalWheelCapture}
          className={`${docked ? 'mt-2 rounded-[var(--radius-lg)] shadow-none' : 'rounded-[var(--radius-lg)] shadow-[var(--shadow-dropdown)]'} min-h-0 flex-1 overflow-hidden border border-[var(--color-terminal-border)] bg-[var(--color-terminal-bg)]`}
        >
          <div
            ref={hostRef}
            data-testid={testId}
            className="settings-terminal-host h-full w-full overflow-hidden px-2 pb-2 pt-1.5"
          />
        </div>
      )}
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

function TerminalHelpHint({ compact = false }: { compact?: boolean }) {
  const t = useTranslation()
  const tooltipId = useId()
  const [open, setOpen] = useState(false)

  return (
    <span className="group relative inline-flex shrink-0">
      <button
        type="button"
        aria-label={t('settings.terminal.infoLabel')}
        aria-describedby={tooltipId}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false)
        }}
        className={`${compact ? 'h-6 w-6' : 'h-7 w-7'} inline-flex items-center justify-center rounded-full text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]`}
      >
        <Info className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} aria-hidden="true" strokeWidth={2.2} />
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className={`${open ? 'visible opacity-100' : 'invisible opacity-0'} absolute left-0 top-full z-30 mt-2 w-[min(340px,calc(100vw-3rem))] rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-high)] px-3 py-2 text-left text-xs leading-5 text-[var(--color-text-secondary)] shadow-[var(--shadow-dropdown)] transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100`}
      >
        {t('settings.terminal.description')}
      </span>
    </span>
  )
}

function TerminalToolbarAction({
  icon: Icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-text-tertiary)] transition-[background-color,color,opacity] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Icon className="h-4 w-4" aria-hidden="true" strokeWidth={1.9} />
    </button>
  )
}

function StatusPill({ status, label, compact = false }: { status: TerminalStatus; label: string; compact?: boolean }) {
  const color =
    status === 'running'
      ? 'bg-[var(--color-success)]'
      : status === 'error'
        ? 'bg-[var(--color-error)]'
        : status === 'starting'
          ? 'bg-[var(--color-warning)]'
          : 'bg-[var(--color-text-tertiary)]'

  return (
    <span className={`inline-flex ${compact ? 'h-5 px-2 text-[10px]' : 'h-6 px-2.5 text-[11px]'} shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-low)] font-medium text-[var(--color-text-secondary)]`}>
      <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
      {label}
    </span>
  )
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
    <div className="mb-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3">
      <label className="mb-1.5 block text-sm font-medium text-[var(--color-text-primary)]">
        {t('settings.terminal.bashPathLabel')}
      </label>
      <p className="mb-2 text-xs text-[var(--color-text-tertiary)]">
        {t('settings.terminal.bashPathDescription')}
      </p>
      <div className="flex gap-2">
        <input
          type="text"
          value={bashPath || ''}
          onChange={(e) => { setBashPath(e.target.value); setInvalid(false); setSaved(false) }}
          placeholder={t('settings.terminal.bashPathLabel')}
          className="flex-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm font-mono text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)]"
        />
        <button
          type="button"
          onClick={handleBrowse}
          className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)]"
        >
          <span className="material-symbols-outlined text-[16px]">folder_open</span>
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-text-primary)] px-3 text-xs font-medium text-[var(--color-surface)] transition-colors hover:opacity-90 disabled:opacity-50"
        >
          {saved ? t('settings.terminal.bashPathSaved') : t('settings.terminal.bashPathSave')}
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={saving || bashPath === null}
          className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
        >
          {t('settings.terminal.bashPathReset')}
        </button>
      </div>
      {invalid && (
        <p className="mt-1.5 text-xs text-[var(--color-error)]">
          {t('settings.terminal.bashPathInvalid')}
        </p>
      )}
    </div>
  )
}
