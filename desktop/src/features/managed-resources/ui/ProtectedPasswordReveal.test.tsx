import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from '../../../lib/desktopHost/browserHost'
import { useSettingsStore } from '../../../stores/settingsStore'
import { ProtectedPasswordReveal } from './ProtectedPasswordReveal'

const credentialId = '11111111-1111-4111-8111-111111111111'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-13T10:00:00.000Z'))
  useSettingsStore.setState({ locale: 'en' })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  ;(window as any).desktopHost = undefined
})

describe('ProtectedPasswordReveal', () => {
  it('does not retain a late password or schedule its timer after unmount', async () => {
    let finish!: (result: { ok: true; data: { credentialId: string; kind: 'ssh-password'; password: string; expiresAt: number } }) => void
    const pending = new Promise<{ ok: true; data: { credentialId: string; kind: 'ssh-password'; password: string; expiresAt: number } }>(resolve => { finish = resolve })
    window.desktopHost = { ...browserHost, hostManagement: { ...browserHost.hostManagement, revealCredential: vi.fn(() => pending) } }
    const view = render(<ProtectedPasswordReveal credentialId={credentialId} />)
    fireEvent.click(screen.getByRole('button', { name: /verify.*reveal/i }))
    view.unmount()
    await act(async () => {
      finish({ ok: true, data: { credentialId, kind: 'ssh-password', password: 'LATE_FAKE_REVEAL_ONLY', expiresAt: Date.now() + 15000 } })
      await pending
    })
    expect(document.body).not.toHaveTextContent('LATE_FAKE_REVEAL_ONLY')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows a saved password only after the protected host call and evicts it after 15 seconds', async () => {
    const revealCredential = vi.fn(async () => ({
      ok: true as const,
      data: {
        credentialId,
        kind: 'ssh-password' as const,
        password: 'linux-server-secret',
        expiresAt: Date.now() + 15_000,
      },
    }))
    ;(window as any).desktopHost = {
      ...browserHost,
      hostManagement: { ...browserHost.hostManagement, revealCredential },
    }

    render(<ProtectedPasswordReveal credentialId={credentialId} label="SSH login password" />)
    expect(screen.getByTestId(`protected-password-value-${credentialId}`)).toHaveTextContent('••••••••')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /verify & reveal/i }))
      await Promise.resolve()
    })
    expect(revealCredential).toHaveBeenCalledWith(credentialId)
    expect(screen.getByTestId(`protected-password-value-${credentialId}`)).toHaveTextContent('linux-server-secret')
    expect(screen.queryByRole('button', { name: /copy/i })).not.toBeInTheDocument()

    act(() => vi.advanceTimersByTime(15_000))
    expect(screen.getByTestId(`protected-password-value-${credentialId}`)).toHaveTextContent('••••••••')
    expect(screen.queryByText('linux-server-secret')).not.toBeInTheDocument()
  })

  it('never renders plaintext when Windows re-authentication is denied', async () => {
    ;(window as any).desktopHost = {
      ...browserHost,
      hostManagement: {
        ...browserHost.hostManagement,
        revealCredential: vi.fn(async () => ({
          ok: false as const,
          error: {
            code: 'OS_AUTH_FAILED',
            messageKey: 'managedResources.errors.OS_AUTH_FAILED',
          },
        })),
      },
    }

    render(<ProtectedPasswordReveal credentialId={credentialId} compact />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /verify & reveal/i }))
      await Promise.resolve()
    })
    expect(screen.getByTestId(`protected-password-value-${credentialId}`)).toHaveTextContent('••••••••')
    expect(screen.getByRole('alert')).toHaveTextContent('The Windows account password was not accepted')
  })
})
