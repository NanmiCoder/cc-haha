import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'

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
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn()
      disconnect = vi.fn()
    })
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  })

  it('shows a desktop-runtime empty state outside Tauri', () => {
    render(<TerminalSettings />)

    expect(screen.getByText(/claude-haha/)).toBeInTheDocument()
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

  it('saves a custom Windows bash path from the terminal settings panel', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    terminalMocks.available = true
    terminalMocks.getBashPath.mockResolvedValue('C:\\Program Files\\Git\\bin\\bash.exe')

    render(<TerminalSettings />)

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

    render(<TerminalSettings />)

    const input = await screen.findByPlaceholderText('Bash Path')
    fireEvent.change(input, { target: { value: 'C:\\missing\\bash.exe' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Path does not exist. Select a valid Bash executable.')).toBeInTheDocument()
  })
})
