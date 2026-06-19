import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type WheelEvent } from 'react'
import { Info } from 'lucide-react'
import { useTranslation, type TranslationKey } from '../i18n'
import { terminalApi } from '../api/terminal'
import { useSettingsStore } from '../stores/settingsStore'
import { Dropdown } from '../components/shared/Dropdown'
import { Input } from '../components/shared/Input'
import { Button } from '../components/shared/Button'
import type { DesktopTerminalStartupShell } from '../types/settings'
import { getDesktopHost } from '../lib/desktopHost'
import {
  attachTerminalRuntime,
  createLocalTerminalRuntimeId,
  destroyTerminalRuntime,
  getTerminalRuntime,
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
  const hostRef = useRef<HTMLDivElement | null>(null)
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

  const startTerminal = useCallback(async () => {
    if (!terminalApi.isAvailable()) {
      updateTerminalRuntime(runtime, { status: 'unavailable' })
      return
    }

    const host = hostRef.current
    if (!host) return

    updateTerminalRuntime(runtime, { error: null, status: 'starting', shellInfo: null })

    const existing = runtime.nativeSessionId
    if (existing) {
      await terminalApi.kill(existing).catch(() => {})
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

    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ])

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: "var(--font-mono), 'SFMono-Regular', Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 4000,
      theme: {
        background: '#121212',
        foreground: '#d7d2d0',
        cursor: '#ffb59f',
        selectionBackground: '#5f4a40',
        black: '#1f1f1f',
        red: '#ff6d67',
        green: '#7ef18a',
        yellow: '#f8c55f',
        blue: '#77a8ff',
        magenta: '#d699ff',
        cyan: '#61d6d6',
        white: '#d7d2d0',
        brightBlack: '#8f8683',
        brightRed: '#ff8a85',
        brightGreen: '#9ff7a7',
        brightYellow: '#ffdd7a',
        brightBlue: '#a6c5ff',
        brightMagenta: '#e3b8ff',
        brightCyan: '#8ceeee',
        brightWhite: '#ffffff',
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)

    // Clipboard wiring. xterm itself ships no copy/paste — without this,
    // Ctrl+C only sends SIGINT and there's no way to lift selected text out.
    // Conventions follow VS Code / GNOME Terminal on Windows + Linux:
    //   - Ctrl+Shift+C / Ctrl+Insert  → copy current selection
    //   - Ctrl+Shift+V / Shift+Insert → paste clipboard into the PTY
    //   - Ctrl+C with an active selection → copy (then clear selection) so the
    //     muscle-memory shortcut works; with no selection it falls through to
    //     the shell as SIGINT, unchanged.
    //   - right-click → copy selection if any, else paste
    const writeToPty = (data: string) => {
      const sessionId = runtime.nativeSessionId
      if (sessionId) void terminalApi.write(sessionId, data).catch(() => {})
    }
    const copySelection = (): boolean => {
      const selection = terminal.getSelection()
      if (!selection) return false
      void navigator.clipboard?.writeText(selection).catch(() => {})
      return true
    }
    const pasteClipboard = () => {
      void navigator.clipboard?.readText().then((text) => {
        if (text) writeToPty(text)
      }).catch(() => {})
    }

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const ctrl = event.ctrlKey
      const shift = event.shiftKey
      const key = event.key

      if (ctrl && shift && (key === 'C' || key === 'c')) {
        copySelection()
        return false
      }
      if (ctrl && shift && (key === 'V' || key === 'v')) {
        pasteClipboard()
        return false
      }
      // Ctrl+Insert / Shift+Insert mirror the classic terminal bindings.
      if (ctrl && key === 'Insert') {
        copySelection()
        return false
      }
      if (shift && key === 'Insert') {
        pasteClipboard()
        return false
      }
      // Bare Ctrl+C: copy when something is selected, else let SIGINT through.
      if (ctrl && !shift && (key === 'C' || key === 'c') && terminal.hasSelection()) {
        copySelection()
        terminal.clearSelection()
        return false
      }
      return true
    })

    // startTerminal can run again (restart button) against the *same* host
    // node, so remove any contextmenu handler bound by a previous run before
    // attaching a fresh one — otherwise they stack and fire N times.
    const hostWithHandler = host as HTMLDivElement & {
      __ccCopyMenuHandler?: (event: MouseEvent) => void
    }
    if (hostWithHandler.__ccCopyMenuHandler) {
      host.removeEventListener('contextmenu', hostWithHandler.__ccCopyMenuHandler)
    }
    const contextMenuHandler = (event: MouseEvent) => {
      event.preventDefault()
      if (!copySelection()) pasteClipboard()
    }
    hostWithHandler.__ccCopyMenuHandler = contextMenuHandler
    host.addEventListener('contextmenu', contextMenuHandler)

    updateTerminalRuntime(runtime, { terminal, fit })
    fit.fit()

    const outputUnlisten = await terminalApi.onOutput((payload) => {
      if (payload.session_id === runtime.nativeSessionId) {
        terminal.write(payload.data)
      }
    })
    const exitUnlisten = await terminalApi.onExit((payload) => {
      if (payload.session_id !== runtime.nativeSessionId) return
      updateTerminalRuntime(runtime, { status: 'exited' })
      const signal = payload.signal ? `, ${payload.signal}` : ''
      terminal.writeln(`\r\n[process exited: ${payload.code}${signal}]`)
      updateTerminalRuntime(runtime, { nativeSessionId: null })
    })
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

    try {
      const result = await terminalApi.spawn({
        cols: terminal.cols,
        rows: terminal.rows,
        ...(cwd ? { cwd } : {}),
      })
      updateTerminalRuntime(runtime, {
        nativeSessionId: result.session_id,
        shellInfo: { shell: result.shell, cwd: result.cwd },
        status: 'running',
      })
      resizeSession()
    } catch (err) {
      outputUnlisten()
      exitUnlisten()
      terminal.dispose()
      updateTerminalRuntime(runtime, {
        terminal: null,
        fit: null,
        error: err instanceof Error ? err.message : String(err),
        status: 'error',
      })
    }
  }, [cwd, resizeSession, runtime])

  useEffect(() => {
    if (!terminalApi.isAvailable()) return
    if (runtime.terminal) {
      if (hostRef.current) {
        attachTerminalRuntime(runtime, hostRef.current)
      }
      resizeSession()
    } else {
      void startTerminal()
    }

    const observer = new ResizeObserver(() => resizeSession())
    if (hostRef.current) observer.observe(hostRef.current)

    return () => {
      observer.disconnect()
      if (!preserveOnUnmount) {
        destroyTerminalRuntime(runtime.id)
      }
    }
  }, [preserveOnUnmount, resizeSession, runtime, startTerminal])

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => resizeSession())
    }
  }, [active, resizeSession])

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
        ? 'min-h-0 bg-[var(--color-surface-container-lowest)] px-3 py-1.5'
        : workspace
          ? 'min-h-0 bg-[var(--color-surface)] px-5 py-4'
          : 'min-h-[min(720px,calc(100vh-8rem))]'
    }`}>
      <div
        data-testid="settings-terminal-toolbar"
        className={`${docked ? 'mb-1.5 min-h-8' : 'mb-2 min-h-9'} flex min-w-0 flex-wrap items-center gap-2`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--color-terminal-danger)]" aria-hidden="true" />
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--color-terminal-warning)]" aria-hidden="true" />
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--color-terminal-accent)]" aria-hidden="true" />
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

        <div className="flex shrink-0 items-center gap-1.5">
          {onOpenInTab && (
            <button
              type="button"
              onClick={onOpenInTab}
              className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] px-2.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            >
              <span className="material-symbols-outlined text-[16px]">open_in_new</span>
              {t('terminal.openInTab')}
            </button>
          )}
          {onNewTerminal && (
            <button
              type="button"
              onClick={onNewTerminal}
              className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] px-2.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
              {t('terminal.newTab')}
            </button>
          )}
          <button
            type="button"
            onClick={clearTerminal}
            disabled={!runtime.terminal}
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] px-2.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[16px]">mop</span>
            {t('settings.terminal.clear')}
          </button>
          <button
            type="button"
            onClick={() => void startTerminal()}
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-text-primary)] px-2.5 text-xs font-medium text-[var(--color-surface)] transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          >
            <span className="material-symbols-outlined text-[16px]">restart_alt</span>
            {t('settings.terminal.restart')}
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={t('terminal.closePanel')}
              className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            >
              <span className="material-symbols-outlined text-[17px]">close</span>
            </button>
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
          className="min-h-0 flex-1 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-terminal-border)] bg-[var(--color-terminal-bg)] shadow-[var(--shadow-dropdown)]"
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
