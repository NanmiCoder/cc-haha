import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { providersApi } from '../../api/providers'
import { useProviderStore } from '../../stores/providerStore'
import { useSessionRuntimeStore } from '../../stores/sessionRuntimeStore'
import { useSettingsStore } from '../../stores/settingsStore'
import type { SavedProvider } from '../../types/provider'
import { MagpieConnectionHint, isCliApiErrorText, isConnectionFailureText } from './MagpieConnectionHint'

const magpie: SavedProvider = {
  id: 'magpie-1', presetId: 'magpie', name: 'Magpie', apiKey: '', baseUrl: 'http://127.0.0.1:3425',
  apiFormat: 'anthropic', models: { main: 'kimi/kimi-k3', haiku: 'kimi/kimi-k3', sonnet: 'kimi/kimi-k3', opus: 'kimi/kimi-k3' },
}
const other: SavedProvider = { ...magpie, id: 'other-1', presetId: 'deepseek', name: 'DeepSeek' }

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  useProviderStore.setState({ providers: [magpie, other], activeId: 'magpie-1' })
  useSessionRuntimeStore.setState({ selections: {} })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('MagpieConnectionHint', () => {
  it('points at Magpie when a Magpie session cannot connect, and opens it', async () => {
    const open = vi.spyOn(providersApi, 'openMagpie').mockResolvedValue({ ok: true })
    vi.spyOn(providersApi, 'magpie').mockResolvedValue({
      status: { installed: true, running: true, baseUrl: 'http://127.0.0.1:3425' }, models: [],
    })
    render(<MagpieConnectionHint sessionId="s1" errorText="API Error: Connection error." />)

    expect(screen.getByTestId('magpie-connection-hint')).toHaveTextContent('runs on Magpie on this computer')
    fireEvent.click(screen.getByRole('button', { name: 'Open Magpie' }))
    await waitFor(() => expect(open).toHaveBeenCalled())
  })

  it('recognizes the refused connection as the CLI records it for history', () => {
    // What a closed Magpie leaves in the transcript (the CLI's synthetic reply).
    const replayed = 'API Error: Unable to connect to API (ConnectionRefused)'
    expect(isCliApiErrorText(replayed)).toBe(true)
    expect(isConnectionFailureText(replayed)).toBe(true)
    expect(isCliApiErrorText('The API Error page says…')).toBe(false)
  })

  it('stays out of other providers\' errors and of errors that are not a refused connection', () => {
    const { rerender } = render(<MagpieConnectionHint sessionId="s1" errorText="429 rate limited" />)
    expect(screen.queryByTestId('magpie-connection-hint')).not.toBeInTheDocument()

    // The session itself runs on another provider, though Magpie is the default.
    useSessionRuntimeStore.setState({ selections: { s1: { providerId: 'other-1', modelId: 'deepseek-flash' } } })
    rerender(<MagpieConnectionHint sessionId="s1" errorText="connect ECONNREFUSED 127.0.0.1:3425" />)
    expect(screen.queryByTestId('magpie-connection-hint')).not.toBeInTheDocument()
  })
})
