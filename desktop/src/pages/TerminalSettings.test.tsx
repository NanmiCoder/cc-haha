import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { destroyTerminalRuntime, getTerminalRuntime } from '../lib/terminalRuntime'
import { browserHost } from '../lib/desktopHost/browserHost'

const terminalMocks = vi.hoisted(() => {
  const terminalInstance = {
    cols: 80,
    rows: 24,
    element: null as HTMLElement | null,
    // Real xterm terminals always expose `options`; the theme bridge assigns
    // `options.theme` when the app theme changes.
    options: {} as { theme?: Record<string, string> },
    loadAddon: vi.fn(),
    open: vi.fn(),
    dispose: vi.fn(),
    onData: vi.fn(),
    onTitleChange: vi.fn((_listener: (title: string) => void) => ({ dispose: vi.fn() })),
    write: vi.fn(),
    writeln: vi.fn(),
    clear: vi.fn(),
    focus: vi.fn(),
    getSelection: vi.fn(),
    hasSelection: vi.fn(),
    paste: vi.fn(),
  }
  const fitInstance = {
    fit: vi.fn(),
  }
  return {
    available: false,
    terminalInstance,
    fitInstance,
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onOutput: vi.fn(),
    onExit: vi.fn(),
    getBashPath: vi.fn(),
    setBashPath: vi.fn(),
  }
})

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(() => terminalMocks.terminalInstance),
}))

vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn() }))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(() => terminalMocks.fitInstance),
}))

vi.mock('../api/terminal', () => ({
  terminalApi: {
    isAvailable: () => terminalMocks.available,
    spawn: terminalMocks.spawn,
    write: terminalMocks.write,
    resize: terminalMocks.resize,
    kill: terminalMocks.kill,
    onOutput: terminalMocks.onOutput,
    onExit: terminalMocks.onExit,
    getBashPath: terminalMocks.getBashPath,
    setBashPath: terminalMocks.setBashPath,
  },
}))

import { TerminalSettings } from './TerminalSettings'

describe('TerminalSettings', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    useSettingsStore.setState({
      desktopTerminal: {
        startupShell: 'system',
        customShellPath: '',
      },
      setDesktopTerminal: vi.fn().mockResolvedValue(undefined),
    })
    terminalMocks.available = false
    terminalMocks.spawn.mockReset()
    terminalMocks.write.mockReset()
    terminalMocks.resize.mockReset()
    terminalMocks.kill.mockReset()
    terminalMocks.onOutput.mockReset()
    terminalMocks.onExit.mockReset()
    terminalMocks.getBashPath.mockReset()
    terminalMocks.setBashPath.mockReset()
    terminalMocks.terminalInstance.loadAddon.mockClear()
    terminalMocks.terminalInstance.element = null
    terminalMocks.terminalInstance.open.mockClear()
    terminalMocks.terminalInstance.dispose.mockClear()
    terminalMocks.terminalInstance.onData.mockClear()
    terminalMocks.terminalInstance.write.mockClear()
    terminalMocks.terminalInstance.writeln.mockClear()
    terminalMocks.terminalInstance.clear.mockClear()
    terminalMocks.terminalInstance.focus.mockClear()
    terminalMocks.terminalInstance.getSelection.mockReset()
    terminalMocks.terminalInstance.hasSelection.mockReset()
    terminalMocks.terminalInstance.paste.mockClear()
    terminalMocks.terminalInstance.getSelection.mockReturnValue('')
    terminalMocks.terminalInstance.hasSelection.mockReturnValue(false)
    terminalMocks.fitInstance.fit.mockClear()
    terminalMocks.onOutput.mockResolvedValue(vi.fn())
    terminalMocks.onExit.mockResolvedValue(vi.fn())
    terminalMocks.getBashPath.mockResolvedValue(null)
    terminalMocks.setBashPath.mockResolvedValue(undefined)
    terminalMocks.write.mockResolvedValue(undefined)
    terminalMocks.resize.mockResolvedValue(undefined)
    terminalMocks.kill.mockResolvedValue(undefined)
    terminalMocks.spawn.mockResolvedValue({
      session_id: 7,
      shell: '/bin/zsh',
      cwd: '/Users/test',
    })
    Reflect.deleteProperty(window, 'desktopHost')
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn()
      disconnect = vi.fn()
    })
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  })

  it('resolves typography and enables links without forcing history scroll', async () => {
    terminalMocks.available = true
    document.documentElement.style.setProperty('--font-mono', '"Test Mono", monospace')
    render(<TerminalSettings />)
    await waitFor(() => expect(terminalMocks.spawn).toHaveBeenCalled())
    const { Terminal } = await import('@xterm/xterm')
    expect(Terminal).toHaveBeenLastCalledWith(expect.objectContaining({
      fontFamily: '"Test Mono", monospace', fontSize: 13, letterSpacing: 0, cursorStyle: 'bar',
      scrollOnEraseInDisplay: false,
    }))
    const { WebLinksAddon } = await import('@xterm/addon-web-links')
    expect(WebLinksAddon).toHaveBeenCalledWith(expect.any(Function))
    const open = vi.spyOn(browserHost.shell, 'open').mockResolvedValue(undefined)
    const handleLink = vi.mocked(WebLinksAddon).mock.calls.at(-1)![0]!
    handleLink(new MouseEvent('click'), 'https://example.com/docs')
    expect(open).toHaveBeenCalledWith('https://example.com/docs')
    handleLink(new MouseEvent('click'), 'javascript:alert(1)')
    expect(open).toHaveBeenCalledTimes(1)
    document.documentElement.style.removeProperty('--font-mono')
  })

  it('exposes live title and restart to workspace chrome without a second toolbar', async () => {
    terminalMocks.available = true
    const { unmount } = render(<TerminalSettings runtimeId="chrome-bridge" compactHeader />)
    await waitFor(() => expect(terminalMocks.spawn).toHaveBeenCalled())
    expect(screen.queryByTestId('settings-terminal-toolbar')).not.toBeInTheDocument()
    const runtime = getTerminalRuntime('chrome-bridge', 'idle')
    act(() => terminalMocks.terminalInstance.onTitleChange.mock.calls.at(-1)?.[0]('project — zsh'))
    expect(runtime.title).toBe('project — zsh')
    await act(async () => { runtime.restart?.() })
    expect(terminalMocks.spawn).toHaveBeenCalledTimes(2)
    expect(runtime.title).toBe('')
    unmount()
    expect(runtime.restart).toBeNull()
  })

  it('shows a desktop-runtime empty state outside Tauri', () => {
    render(<TerminalSettings />)

    expect(screen.getByTestId('settings-terminal-toolbar')).toHaveTextContent('Terminal')
    expect(screen.getByText('Desktop runtime required')).toBeInTheDocument()
    expect(terminalMocks.spawn).not.toHaveBeenCalled()
  })

  it('starts a host terminal session when Tauri is available', async () => {
    terminalMocks.available = true

    render(<TerminalSettings />)

    await waitFor(() => {
      expect(terminalMocks.spawn).toHaveBeenCalledWith({ cols: 80, rows: 24, requestId: expect.any(String) })
    })
    expect(screen.getByText('/bin/zsh')).toBeInTheDocument()
    expect(screen.getByText('/Users/test')).toBeInTheDocument()
    expect(terminalMocks.terminalInstance.open).toHaveBeenCalled()
    expect(terminalMocks.fitInstance.fit).toHaveBeenCalled()
  })

  it('keeps the terminal runtime current across the StrictMode effect replay', async () => {
    terminalMocks.available = true

    render(
      <StrictMode>
        <TerminalSettings runtimeId="strict-mode-terminal" />
      </StrictMode>,
    )

    await waitFor(() => expect(terminalMocks.spawn).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Running')).toBeInTheDocument()

    destroyTerminalRuntime('strict-mode-terminal')
  })

  it('does not start duplicate xterm surfaces for one runtime', async () => {
    terminalMocks.available = true
    terminalMocks.terminalInstance.open.mockImplementation((host: HTMLElement) => {
      const element = document.createElement('div')
      element.className = 'xterm'
      terminalMocks.terminalInstance.element = element
      host.appendChild(element)
    })

    render(
      <>
        <TerminalSettings runtimeId="shared-terminal-runtime" preserveOnUnmount />
        <TerminalSettings runtimeId="shared-terminal-runtime" preserveOnUnmount testId="settings-terminal-host-secondary" />
      </>,
    )

    await waitFor(() => expect(terminalMocks.spawn).toHaveBeenCalled())
    await vi.dynamicImportSettled()

    expect(terminalMocks.spawn).toHaveBeenCalledTimes(1)
    expect(terminalMocks.terminalInstance.open).toHaveBeenCalledTimes(1)
    expect(document.body.querySelectorAll('.settings-terminal-host .xterm')).toHaveLength(1)

    destroyTerminalRuntime('shared-terminal-runtime')
  })

  it('uses one compact toolbar instead of a nested terminal title bar', async () => {
    terminalMocks.available = true

    render(<TerminalSettings />)

    await waitFor(() => expect(terminalMocks.spawn).toHaveBeenCalled())
    const toolbar = screen.getByTestId('settings-terminal-toolbar')
    expect(toolbar).toHaveTextContent('/bin/zsh')
    expect(screen.getByTestId('settings-terminal-frame')).toBeInTheDocument()
    expect(screen.queryByText('Host shell')).not.toBeInTheDocument()

    // Still one bar — but it is now the ink window's own title bar rather than
    // a second strip floating above it on the page ground (handoff §9).
    expect(toolbar.className).toContain('bg-[var(--color-terminal-header)]')
    const panel = toolbar.parentElement
    expect(panel?.className).toContain('bg-[var(--color-terminal-bg)]')
    expect(panel?.className).toContain('rounded-[var(--radius-xl)]')
    expect(panel).toContainElement(screen.getByTestId('settings-terminal-frame'))
  })

  it('uses a flush workspace surface while keeping shell status and actions when docked', async () => {
    terminalMocks.available = true
    render(<TerminalSettings docked />)
    await waitFor(() => expect(terminalMocks.spawn).toHaveBeenCalled())
    const toolbar = screen.getByTestId('settings-terminal-toolbar')
    expect(toolbar.querySelector('h2')).toBeNull()
    expect(toolbar.parentElement?.className).not.toContain('rounded-')
    expect(toolbar.parentElement?.className).not.toContain('shadow-')
    expect(toolbar).toHaveTextContent('/bin/zsh')
    expect(toolbar).toHaveTextContent('Running')
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(terminalMocks.terminalInstance.clear).toHaveBeenCalled()
  })

  it('puts the cwd and shell in mono and keeps the status a bare dot', async () => {
    terminalMocks.available = true

    render(<TerminalSettings />)

    await waitFor(() => expect(terminalMocks.spawn).toHaveBeenCalled())
    // The cwd is the window title in §9, so it reads as a path, not prose.
    expect(screen.getByText('/Users/test').className).toContain('truncate')
    expect(screen.getByText('/Users/test').parentElement?.className).toContain('font-mono')
    expect(screen.getByText('Running')).toBeInTheDocument()
  })

  it('drops the ink chrome when there is no session to frame', () => {
    render(<TerminalSettings />)

    // Page tokens are inverted against the terminal ground; framing the
    // "desktop runtime required" empty state in ink would leave it unreadable.
    const toolbar = screen.getByTestId('settings-terminal-toolbar')
    expect(toolbar.className).not.toContain('bg-[var(--color-terminal-header)]')
    expect(toolbar.parentElement?.className).not.toContain('bg-[var(--color-terminal-bg)]')
    expect(screen.getByText('Desktop runtime required')).toBeInTheDocument()
  })

  it('exposes the header actions as named icon buttons', async () => {
    terminalMocks.available = true

    render(<TerminalSettings onClose={vi.fn()} />)

    await waitFor(() => expect(terminalMocks.spawn).toHaveBeenCalled())
    // Icon-only now, so the label is the only accessible name they have.
    for (const name of ['Clear', 'Restart', 'Close terminal panel']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: 'Clear' }).className)
      .toContain('hover:bg-[var(--color-terminal-selection)]')
  })

  it('shows setup guidance from the terminal info button', () => {
    render(<TerminalSettings />)

    const button = screen.getByRole('button', { name: 'Terminal setup help' })
    const help = screen.getByRole('tooltip')
    expect(button).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(button)

    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(help).toHaveTextContent('plugin, skill, and MCP setup')
    expect(help).toHaveTextContent('claude-haha plugin install')
  })

  it('lets the settings page keep scrolling when the terminal is not focused', async () => {
    terminalMocks.available = true
    const container = document.createElement('div')
    container.style.overflowY = 'auto'
    let scrollTop = 0
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 300 })
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value) => { scrollTop = value },
    })
    const scrollBy = vi.fn(({ top }: ScrollToOptions) => {
      scrollTop += Number(top ?? 0)
    })
    Object.defineProperty(container, 'scrollBy', { configurable: true, value: scrollBy })
    document.body.appendChild(container)

    render(<TerminalSettings />, { container })
    await waitFor(() => expect(terminalMocks.spawn).toHaveBeenCalled())

    fireEvent.wheel(screen.getByTestId('settings-terminal-frame'), { deltaY: 48 })

    expect(scrollBy).toHaveBeenCalledWith({ top: 48, left: 0 })
    expect(scrollTop).toBe(48)
  })

  it('starts in the provided cwd when embedded in a project session', async () => {
    terminalMocks.available = true

    render(<TerminalSettings cwd="/tmp/current-project" />)

    await waitFor(() => {
      expect(terminalMocks.spawn).toHaveBeenCalledWith({
        cols: 80,
        rows: 24,
        cwd: '/tmp/current-project',
        requestId: expect.any(String),
      })
    })
  })

  it('preserves output and exit delivered before the spawn IPC reply without reviving the process', async () => {
    terminalMocks.available = true
    terminalMocks.spawn.mockImplementation(async (input) => {
      expect(input.requestId).toEqual(expect.any(String))
      const output = terminalMocks.onOutput.mock.calls.at(-1)![0]
      const exit = terminalMocks.onExit.mock.calls.at(-1)![0]
      output({ session_id: 91, requestId: 'another-start', data: 'wrong terminal' })
      output({ session_id: 7, requestId: input.requestId, data: 'startup prompt' })
      exit({ session_id: 7, requestId: input.requestId, code: 0 })
      return { session_id: 7, shell: '/bin/zsh', cwd: '/fixture' }
    })
    render(<TerminalSettings />)
    await waitFor(() => expect(terminalMocks.terminalInstance.write).toHaveBeenCalledWith('startup prompt'))
    expect(terminalMocks.terminalInstance.write).not.toHaveBeenCalledWith('wrong terminal')
    expect(screen.getByText('Exited')).toBeInTheDocument()
    expect(screen.queryByText('Running')).toBeNull()
  })

  it('writes matching terminal output events into xterm', async () => {
    terminalMocks.available = true
    let outputHandler: ((payload: { session_id: number; data: string }) => void) | undefined
    terminalMocks.onOutput.mockImplementation(async (handler) => {
      outputHandler = handler
      return vi.fn()
    })

    render(<TerminalSettings />)
    await waitFor(() => expect(terminalMocks.spawn).toHaveBeenCalled())

    act(() => {
      outputHandler?.({ session_id: 7, data: 'hello\r\n' })
      outputHandler?.({ session_id: 8, data: 'ignored\r\n' })
    })

    expect(terminalMocks.terminalInstance.write).toHaveBeenCalledWith('hello\r\n')
    expect(terminalMocks.terminalInstance.write).not.toHaveBeenCalledWith('ignored\r\n')
  })

  it('copies the terminal selection through the desktop clipboard on Windows shortcuts', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    terminalMocks.available = true
    terminalMocks.terminalInstance.hasSelection.mockReturnValue(true)
    terminalMocks.terminalInstance.getSelection.mockReturnValue('Microsoft Windows [Version 10.0.19045]')
    const writeText = vi.fn().mockResolvedValue(undefined)
    window.desktopHost = {
      ...browserHost,
      capabilities: { ...browserHost.capabilities, clipboard: true },
      clipboard: {
        readText: vi.fn(),
        writeText,
      },
    }

    render(<TerminalSettings />)
    await waitFor(() => expect(terminalMocks.spawn).toHaveBeenCalled())

    fireEvent.keyDown(screen.getByTestId('settings-terminal-frame'), { key: 'c', ctrlKey: true })

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('Microsoft Windows [Version 10.0.19045]')
    })
    fireEvent.keyDown(screen.getByTestId('settings-terminal-frame'), { key: 'C', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(screen.getByTestId('settings-terminal-frame'), { key: 'Insert', ctrlKey: true })

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(3)
    })
    expect(terminalMocks.terminalInstance.focus).toHaveBeenCalled()
  })

  it('pastes clipboard text into xterm on Windows paste shortcuts', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    terminalMocks.available = true
    const readText = vi.fn().mockResolvedValue('dir')
    window.desktopHost = {
      ...browserHost,
      capabilities: { ...browserHost.capabilities, clipboard: true },
      clipboard: {
        readText,
        writeText: vi.fn(),
      },
    }

    render(<TerminalSettings />)
    await waitFor(() => expect(terminalMocks.spawn).toHaveBeenCalled())

    fireEvent.keyDown(screen.getByTestId('settings-terminal-frame'), { key: 'v', ctrlKey: true })

    await waitFor(() => {
      expect(terminalMocks.terminalInstance.paste).toHaveBeenCalledWith('dir')
    })
    fireEvent.keyDown(screen.getByTestId('settings-terminal-frame'), { key: 'V', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(screen.getByTestId('settings-terminal-frame'), { key: 'Insert', shiftKey: true })

    await waitFor(() => {
      expect(terminalMocks.terminalInstance.paste).toHaveBeenCalledTimes(3)
    })
    expect(terminalMocks.terminalInstance.focus).toHaveBeenCalled()
  })

  it('does not intercept Ctrl+C as copy when the Windows terminal has no selection', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    terminalMocks.available = true
    const writeText = vi.fn().mockResolvedValue(undefined)
    window.desktopHost = {
      ...browserHost,
      capabilities: { ...browserHost.capabilities, clipboard: true },
      clipboard: {
        readText: vi.fn(),
        writeText,
      },
    }

    render(<TerminalSettings />)
    await waitFor(() => expect(terminalMocks.spawn).toHaveBeenCalled())

    const event = new window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: 'c',
    })
    screen.getByTestId('settings-terminal-frame').dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('can preserve and reattach a running terminal runtime across unmounts', async () => {
    terminalMocks.available = true

    const first = render(<TerminalSettings runtimeId="shared-runtime" preserveOnUnmount />)
    await waitFor(() => expect(terminalMocks.spawn).toHaveBeenCalledTimes(1))

    first.unmount()
    expect(terminalMocks.kill).not.toHaveBeenCalled()

    render(<TerminalSettings runtimeId="shared-runtime" />)

    await waitFor(() => {
      expect(terminalMocks.terminalInstance.open).toHaveBeenCalledTimes(2)
    })
    expect(terminalMocks.spawn).toHaveBeenCalledTimes(1)

    destroyTerminalRuntime('shared-runtime')
  })

  it('repaints a running terminal when the app theme changes', async () => {
    terminalMocks.available = true
    // Pick themes by hand here: while following the system the OS decides the
    // dark half, so setTheme('dark') would resolve back to the light theme.
    useUIStore.setState({ followSystemTheme: false })
    useUIStore.getState().setTheme('dark')

    render(<TerminalSettings runtimeId="theme-runtime" />)
    await waitFor(() => expect(terminalMocks.spawn).toHaveBeenCalledTimes(1))

    const darkTheme = terminalMocks.terminalInstance.options.theme
    expect(darkTheme).toBeDefined()

    // The runtime outlives the component, so a terminal opened under one theme
    // used to keep that palette for the rest of the session.
    act(() => { useUIStore.getState().setTheme('white') })

    await waitFor(() => {
      expect(terminalMocks.terminalInstance.options.theme).not.toBe(darkTheme)
    })
    expect(terminalMocks.terminalInstance.options.theme).toHaveProperty('background')

    destroyTerminalRuntime('theme-runtime')
  })

  it('shows Windows-only startup shell controls in settings mode', () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      platform: 'Win32',
      userAgent: 'Windows',
    })

    render(<TerminalSettings showPreferences />)

    expect(screen.getAllByText('Startup shell')).toHaveLength(2)
    expect(screen.getByText('Use for new terminal sessions and after restart.')).toBeInTheDocument()
  })

  it('saves a custom Windows bash path from the terminal settings panel', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    terminalMocks.available = true
    terminalMocks.getBashPath.mockResolvedValue('C:\\Program Files\\Git\\bin\\bash.exe')

    render(<TerminalSettings showPreferences />)

    const input = await screen.findByDisplayValue('C:\\Program Files\\Git\\bin\\bash.exe')
    fireEvent.change(input, { target: { value: ' C:\\Tools\\Git\\bin\\bash.exe ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(terminalMocks.setBashPath).toHaveBeenCalledWith('C:\\Tools\\Git\\bin\\bash.exe')
    })
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeInTheDocument()
  })

  it('shows an invalid path message when native bash path validation fails', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    terminalMocks.available = true
    terminalMocks.setBashPath.mockRejectedValue(new Error('terminal bash path does not exist'))

    render(<TerminalSettings showPreferences />)

    const input = await screen.findByPlaceholderText('Bash Path')
    fireEvent.change(input, { target: { value: 'C:\\missing\\bash.exe' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Path does not exist. Select a valid Bash executable.')).toBeInTheDocument()
  })

  it('selects a Windows bash path through the injected desktop host', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    terminalMocks.available = true
    const open = vi.fn().mockResolvedValue('C:\\Program Files\\Git\\bin\\bash.exe')
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        dialogs: true,
      },
      dialogs: {
        ...browserHost.dialogs,
        open,
      },
    }

    render(<TerminalSettings showPreferences />)

    await screen.findByPlaceholderText('Bash Path')
    fireEvent.click(screen.getByText('folder_open').closest('button')!)

    expect(await screen.findByDisplayValue('C:\\Program Files\\Git\\bin\\bash.exe')).toBeInTheDocument()
    expect(open).toHaveBeenCalledWith({
      title: 'Bash Path',
      multiple: false,
      filters: [{
        name: 'Bash Executable',
        extensions: ['exe', '', 'bat', 'cmd', 'ps1'],
      }],
    })
  })
})
