import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'
import { destroyTerminalRuntime } from '../lib/terminalRuntime'
import { browserHost } from '../lib/desktopHost/browserHost'

const terminalMocks = vi.hoisted(() => {
  const terminalInstance = {
    cols: 80,
    rows: 24,
    loadAddon: vi.fn(),
    open: vi.fn(),
    dispose: vi.fn(),
    onData: vi.fn(),
    write: vi.fn(),
    writeln: vi.fn(),
    clear: vi.fn(),
    attachCustomKeyEventHandler: vi.fn(),
    getSelection: vi.fn(() => ''),
    hasSelection: vi.fn(() => false),
    clearSelection: vi.fn(),
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
    terminalMocks.terminalInstance.open.mockClear()
    terminalMocks.terminalInstance.dispose.mockClear()
    terminalMocks.terminalInstance.onData.mockClear()
    terminalMocks.terminalInstance.write.mockClear()
    terminalMocks.terminalInstance.writeln.mockClear()
    terminalMocks.terminalInstance.clear.mockClear()
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
      expect(terminalMocks.spawn).toHaveBeenCalledWith({ cols: 80, rows: 24 })
    })
    expect(screen.getByText('/bin/zsh')).toBeInTheDocument()
    expect(screen.getByText('/Users/test')).toBeInTheDocument()
    expect(terminalMocks.terminalInstance.open).toHaveBeenCalled()
    expect(terminalMocks.fitInstance.fit).toHaveBeenCalled()
  })

  it('uses one compact toolbar instead of a nested terminal title bar', async () => {
    terminalMocks.available = true

    render(<TerminalSettings />)

    await waitFor(() => expect(terminalMocks.spawn).toHaveBeenCalled())
    expect(screen.getByTestId('settings-terminal-toolbar')).toHaveTextContent('/bin/zsh')
    expect(screen.getByTestId('settings-terminal-frame')).toBeInTheDocument()
    expect(screen.queryByText('Host shell')).not.toBeInTheDocument()
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
      })
    })
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
