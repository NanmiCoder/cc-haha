import { useCallback, useEffect, useRef, useState } from 'react'
import type { Terminal as XTermTerminal } from '@xterm/xterm'
import type { FitAddon as XTermFitAddon } from '@xterm/addon-fit'
import { useTranslation, type TranslationKey } from '../i18n'
import { terminalApi } from '../api/terminal'

type TerminalStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error' | 'unavailable'

const STATUS_LABEL_KEYS: Record<TerminalStatus, TranslationKey> = {
  idle: 'settings.terminal.status.idle',
  starting: 'settings.terminal.status.starting',
  running: 'settings.terminal.status.running',
  exited: 'settings.terminal.status.exited',
  error: 'settings.terminal.status.error',
  unavailable: 'settings.terminal.status.unavailable',
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
}: TerminalSettingsProps = {}) {
  const t = useTranslation()
  const isWindows = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('win')
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<XTermTerminal | null>(null)
  const fitRef = useRef<XTermFitAddon | null>(null)
  const sessionIdRef = useRef<number | null>(null)
  const unlistenRef = useRef<Array<() => void>>([])
  const [status, setStatus] = useState<TerminalStatus>(() => terminalApi.isAvailable() ? 'idle' : 'unavailable')
  const [error, setError] = useState<string | null>(null)
  const [shellInfo, setShellInfo] = useState<{ shell: string; cwd: string } | null>(null)

  const resizeSession = useCallback(() => {
    const terminal = terminalRef.current
    const fit = fitRef.current
    const sessionId = sessionIdRef.current
    if (!terminal || !fit) return

    fit.fit()
    if (sessionId) {
      void terminalApi.resize(sessionId, terminal.cols, terminal.rows).catch(() => {})
    }
  }, [])

  const startTerminal = useCallback(async () => {
    if (!terminalApi.isAvailable()) {
      setStatus('unavailable')
      return
    }

    const host = hostRef.current
    if (!host) return

    setError(null)
    setStatus('starting')
    setShellInfo(null)

    const existing = sessionIdRef.current
    if (existing) {
      await terminalApi.kill(existing).catch(() => {})
      sessionIdRef.current = null
    }
    unlistenRef.current.forEach((unlisten) => unlisten())
    unlistenRef.current = []

    terminalRef.current?.dispose()
    fitRef.current = null
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
    terminalRef.current = terminal
    fitRef.current = fit
    fit.fit()

    const outputUnlisten = await terminalApi.onOutput((payload) => {
      if (payload.session_id === sessionIdRef.current) {
        terminal.write(payload.data)
      }
    })
    const exitUnlisten = await terminalApi.onExit((payload) => {
      if (payload.session_id !== sessionIdRef.current) return
      setStatus('exited')
      const signal = payload.signal ? `, ${payload.signal}` : ''
      terminal.writeln(`\r\n[process exited: ${payload.code}${signal}]`)
      sessionIdRef.current = null
    })
    unlistenRef.current = [outputUnlisten, exitUnlisten]

    terminal.onData((data) => {
      const sessionId = sessionIdRef.current
      if (sessionId) {
        void terminalApi.write(sessionId, data).catch((err) => {
          setError(err instanceof Error ? err.message : String(err))
          setStatus('error')
        })
      }
    })

    try {
      const result = await terminalApi.spawn({
        cols: terminal.cols,
        rows: terminal.rows,
        ...(cwd ? { cwd } : {}),
      })
      sessionIdRef.current = result.session_id
      setShellInfo({ shell: result.shell, cwd: result.cwd })
      setStatus('running')
      resizeSession()
    } catch (err) {
      outputUnlisten()
      exitUnlisten()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }, [cwd, resizeSession])

  useEffect(() => {
    if (!terminalApi.isAvailable()) return
    void startTerminal()

    const observer = new ResizeObserver(() => resizeSession())
    if (hostRef.current) observer.observe(hostRef.current)

    return () => {
      observer.disconnect()
      const sessionId = sessionIdRef.current
      if (sessionId) {
        void terminalApi.kill(sessionId).catch(() => {})
      }
      terminalRef.current?.dispose()
      terminalRef.current = null
      fitRef.current = null
      unlistenRef.current.forEach((unlisten) => unlisten())
      unlistenRef.current = []
      sessionIdRef.current = null
    }
  }, [resizeSession, startTerminal])

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => resizeSession())
    }
  }, [active, resizeSession])

  const clearTerminal = () => {
    terminalRef.current?.clear()
  }

  return (
    <div className={`flex h-full flex-col overflow-hidden ${
      docked
        ? 'min-h-0 bg-[var(--color-surface-container-lowest)] px-3 py-2'
        : workspace
          ? 'min-h-0 bg-[var(--color-surface)] px-5 py-4'
          : 'min-h-[620px]'
    }`}>
      <div className={`${docked ? 'mb-2' : 'mb-3'} flex flex-wrap items-start justify-between gap-3`}>
        <div className="min-w-0">
          <h2 className={`${docked ? 'text-sm' : 'text-base'} font-semibold text-[var(--color-text-primary)]`}>
            {t('settings.terminal.title')}
          </h2>
          {!docked && (
            <p className="mt-0.5 max-w-2xl text-sm text-[var(--color-text-tertiary)]">
              {t('settings.terminal.description')}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
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
            disabled={!terminalRef.current}
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

      <div className={`${docked ? 'mb-2' : 'mb-3'} flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-tertiary)]`}>
        <StatusPill status={status} label={t(STATUS_LABEL_KEYS[status])} />
        {shellInfo && (
          <>
            <span className="font-mono">{shellInfo.shell}</span>
            <span className="text-[var(--color-border)]">/</span>
            <span className="min-w-0 max-w-full truncate font-mono">{shellInfo.cwd}</span>
          </>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded-[var(--radius-md)] border border-[var(--color-error)]/20 bg-[var(--color-error)]/10 px-3 py-2 text-sm text-[var(--color-error)]">
          {error}
        </div>
      )}

      {isWindows && (
        <BashPathSettings isTauri={terminalApi.isAvailable()} />
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
        <div className="min-h-0 flex-1 overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-terminal-border)] bg-[var(--color-terminal-bg)] shadow-[var(--shadow-dropdown)]">
          <div className="flex h-8 items-center gap-2 border-b border-[var(--color-terminal-border)] bg-[var(--color-terminal-header)] px-3">
            <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-terminal-danger)]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-terminal-warning)]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-terminal-accent)]" />
            <span className="ml-2 truncate font-mono text-[11px] text-[var(--color-terminal-muted)]">
              {t('settings.terminal.windowTitle')}
            </span>
          </div>
          <div
            ref={hostRef}
            data-testid={testId}
            className="settings-terminal-host h-[calc(100%-2rem)] w-full overflow-hidden p-2"
          />
        </div>
      )}
    </div>
  )
}

function StatusPill({ status, label }: { status: TerminalStatus; label: string }) {
  const color =
    status === 'running'
      ? 'bg-[var(--color-success)]'
      : status === 'error'
        ? 'bg-[var(--color-error)]'
        : status === 'starting'
          ? 'bg-[var(--color-warning)]'
          : 'bg-[var(--color-text-tertiary)]'

  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-2.5 text-[11px] font-medium text-[var(--color-text-secondary)]">
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
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
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
