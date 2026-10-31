import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { matchRuntimeCrashExitCode, splitStartupError, StartupErrorView } from './StartupErrorView'
import { useSettingsStore } from '../../stores/settingsStore'

beforeEach(() => {
  useSettingsStore.setState({ locale: 'zh' })
})

describe('splitStartupError', () => {
  it('separates the timeout message from captured sidecar logs', () => {
    const result = splitStartupError(
      'desktop server did not start listening on 127.0.0.1:57608 within 10 seconds\n\nRecent server logs:\n[stderr] failed to bind\n[exit] sidecar exited (code=1, signal=None)',
    )

    expect(result.message).toBe(
      'desktop server did not start listening on 127.0.0.1:57608 within 10 seconds',
    )
    expect(result.logs).toContain('[stderr] failed to bind')
    expect(result.diagnostics).toContain('Recent server logs:')
  })
})

describe('matchRuntimeCrashExitCode', () => {
  it('recognizes Windows NTSTATUS crash codes in either sign and ignores ordinary exits', () => {
    expect(matchRuntimeCrashExitCode(
      "Error invoking remote method 'desktop:runtime:get-server-url': Error: server sidecar exited after spawn (code=3221225477, signal=null)",
    )).toBe('3221225477 (0xC0000005)')
    expect(matchRuntimeCrashExitCode('[exit] sidecar exited (code=-1073741571, signal=null)')).toBe('3221225725 (0xC00000FD)')
    expect(matchRuntimeCrashExitCode('[exit] sidecar exited (code=1, signal=null)')).toBeNull()
    expect(matchRuntimeCrashExitCode('[exit] sidecar exited (code=null, signal=SIGTERM)')).toBeNull()
    expect(matchRuntimeCrashExitCode('desktop server did not start listening within 10 seconds')).toBeNull()
  })
})

describe('StartupErrorView', () => {
  it('explains a crashed sidecar as a damaged install and points at a reinstall', () => {
    render(
      <StartupErrorView
        error={'server sidecar exited after spawn (code=3221225477, signal=null)\n\nRecent server logs:\n[exit] sidecar exited (code=3221225477, signal=null)'}
      />,
    )

    const hint = screen.getByTestId('startup-crash-hint')
    expect(hint).toHaveTextContent('3221225477 (0xC0000005)')
    expect(hint).toHaveTextContent('完整安装包')
    expect(hint).toHaveTextContent('~/.claude')
  })

  it('shows no crash hint for an ordinary startup failure', () => {
    render(
      <StartupErrorView error={'startup failed\n\nRecent server logs:\n[exit] sidecar exited (code=1, signal=null)'} />,
    )

    expect(screen.queryByTestId('startup-crash-hint')).not.toBeInTheDocument()
  })

  it('shows diagnostics and copies the full payload with the legacy fallback', async () => {
    const originalClipboard = navigator.clipboard
    const originalExecCommand = document.execCommand
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn().mockReturnValue(true),
    })
    const execCommand = vi.mocked(document.execCommand)
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard blocked'))
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    try {
      render(
        <StartupErrorView error={'startup failed\n\nRecent server logs:\n[stderr] boom'} />,
      )

      expect(screen.getByText('本地服务启动失败')).toBeInTheDocument()
      expect(screen.getByText('startup failed')).toBeInTheDocument()
      expect(screen.getByText('[stderr] boom')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: '复制诊断信息' }))

      await waitFor(() => {
        expect(execCommand).toHaveBeenCalledWith('copy')
      })
      expect(writeText).toHaveBeenCalledWith(
        'startup failed\n\nRecent server logs:\n[stderr] boom',
      )
      expect(screen.getByText('已复制')).toBeInTheDocument()
    } finally {
      Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: originalExecCommand,
      })
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      })
    }
  })
})
