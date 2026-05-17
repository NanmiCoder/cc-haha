import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'

import { splitStartupError, StartupErrorView } from './StartupErrorView'

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

describe('StartupErrorView', () => {
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
