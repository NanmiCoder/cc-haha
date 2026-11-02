import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { matchRuntimeCrashExitCode, splitStartupError, StartupErrorView } from './StartupErrorView'
import { formatSidecarStartupTimeout } from '../../lib/sidecarStartupError'
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
  it.each([
    ['listening but silent', true, 'health check timed out'],
    ['never listening', false, 'connect ECONNREFUSED 127.0.0.1:51588'],
  ])('tells the user to retry instead of filing an issue after a %s startup timeout', (_label, listening, lastProbeError) => {
    // On either timeout the host keeps the sidecar running, so Retry resumes
    // waiting on it; the message arrives wrapped by Electron's IPC error (#1746).
    const timeout = formatSidecarStartupTimeout({
      listening,
      host: '127.0.0.1',
      port: 51588,
      healthUrl: 'http://127.0.0.1:51588/health',
      timeoutMs: 30_000,
      lastProbeError,
    })
    render(
      <StartupErrorView
        error={`Error invoking remote method 'desktop:runtime:get-server-url': Error: ${timeout}\n\nRecent server logs:\n[stdout] [local-index] rebuilding 1016 sources (parser v12 → v13)`}
      />,
    )

    expect(screen.getByRole('heading', { name: '本地服务仍在启动' })).toBeInTheDocument()
    expect(screen.getByText(/本地服务进程仍在运行，只是还没完成启动/)).toBeInTheDocument()
    expect(screen.queryByText('本地服务启动失败')).not.toBeInTheDocument()
    expect(screen.queryByText('反馈这个问题时，请把这块诊断信息截图一起发到 issue 里。')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('explains a crashed sidecar and lists what to check before a reinstall', () => {
    render(
      <StartupErrorView
        error={'server sidecar exited after spawn (code=3221225477, signal=null)\n\nRecent server logs:\n[exit] sidecar exited (code=3221225477, signal=null)'}
      />,
    )

    const hint = screen.getByTestId('startup-crash-hint')
    expect(hint).toHaveTextContent('3221225477 (0xC0000005)')
    expect(hint).toHaveTextContent('安全软件')
    expect(hint).toHaveTextContent('完整安装包')
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
      expect(screen.getByText('反馈这个问题时，请把这块诊断信息截图一起发到 issue 里。')).toBeInTheDocument()
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
