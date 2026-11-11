import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ModelSelector } from './ModelSelector'
import { getBaseUrl, setBaseUrl } from '@/api/client'
import { browserHost } from '@/lib/desktopHost/browserHost'
import { isPublicAccessRuntime } from '@/lib/publicAccessRuntime'
import { useProviderStore } from '@/stores/providerStore'
import { useSessionRuntimeStore } from '@/stores/sessionRuntimeStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useTabStore } from '@/stores/tabStore'
import { useUIStore } from '@/stores/uiStore'

const initialUrl = window.location.href
const initialBaseUrl = getBaseUrl()
const initialHost = window.desktopHost
const availability = { 'claude-official': false, 'openai-official': false, 'grok-official': false, 'deepseek-account': true }
const accountModels = { main: 'deepseek-flash', haiku: 'deepseek-flash', sonnet: 'deepseek-v4-pro', opus: 'deepseek-v4-pro' }
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  window.desktopHost = browserHost
  window.history.replaceState(null, '', '/remote')
  setBaseUrl(window.location.origin)
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  useProviderStore.setState(useProviderStore.getInitialState(), true)
  useSessionRuntimeStore.setState({ selections: {} })
  useSettingsStore.setState({ locale: 'en', effortLevel: 'high', currentModel: { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', description: '', context: '' } })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.desktopHost = initialHost
  window.history.replaceState(null, '', initialUrl)
  setBaseUrl(initialBaseUrl)
  useProviderStore.setState(useProviderStore.getInitialState(), true)
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useSessionRuntimeStore.setState(useSessionRuntimeStore.getInitialState(), true)
  useTabStore.setState(useTabStore.getInitialState(), true)
  useUIStore.setState(useUIStore.getInitialState(), true)
})

describe('phone picker through the real provider API and runtime detection', () => {
  it.each(['/remote', '/'])('loads and caches the account snapshot at %s before new-chat remounts', async pathname => {
    window.history.replaceState(null, '', pathname)
    expect(isPublicAccessRuntime()).toBe(pathname === '/remote')
    let finishList!: (response: Response) => void
    const listing = new Promise<Response>(resolve => { finishList = resolve })
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      expect(url.origin).toBe(window.location.origin)
      requests.push(url.pathname + url.search)
      if (url.pathname === '/api/providers') return listing
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))

    const first = render(<ModelSelector runtimeKey="__draft__" compact />)
    expect(screen.queryByText('Configure model provider')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Select model' }))
    expect(screen.getByRole('status')).toHaveTextContent('Loading configured models')
    await act(async () => { finishList(json({ providers: [], activeId: 'deepseek-account', deepSeekAccountModels: accountModels, builtInProviderAvailability: availability })) })
    const dropdown = await screen.findByTestId('model-selector-dropdown')
    fireEvent.click(within(dropdown).getByRole('button', { name: /DeepSeek-V4\.1-Flash/ }))
    expect(useSessionRuntimeStore.getState().selections.__draft__).toMatchObject({ providerId: 'deepseek-account', modelId: 'deepseek-flash' })

    first.unmount()
    useSessionRuntimeStore.setState({ selections: {} })
    render(<ModelSelector runtimeKey="__draft__" compact />)
    expect(screen.getByRole('button', { name: /DeepSeek-V4\.1-Flash, DeepSeek Account/ })).toBeInTheDocument()
    expect(requests).toEqual(['/api/providers'])
  })

  it('selects redacted API-key DeepSeek models without mistaking an empty secret field for no configuration', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname !== '/api/providers') throw new Error(`Unexpected request: ${url.pathname}`)
      return json({
        activeId: 'saved-deepseek', builtInProviderAvailability: { ...availability, 'deepseek-account': false },
        providers: [{ id: 'saved-deepseek', name: 'My DeepSeek', presetId: 'deepseek', apiFormat: 'anthropic', apiKey: '', hasApiKey: true,
          baseUrl: 'https://fixture.invalid/anthropic', models: { main: 'deepseek-v4-pro', haiku: 'deepseek-v4-flash', sonnet: 'deepseek-v4-pro', opus: 'deepseek-v4-pro' } }],
      })
    }))
    render(<ModelSelector runtimeKey="__draft__" compact />)
    fireEvent.click(await screen.findByRole('button', { name: /deepseek-v4-pro, My DeepSeek/ }))
    fireEvent.click(within(screen.getByTestId('model-selector-dropdown')).getByRole('button', { name: /deepseek-v4-flash/ }))
    expect(useSessionRuntimeStore.getState().selections.__draft__).toMatchObject({ providerId: 'saved-deepseek', modelId: 'deepseek-v4-flash' })
    expect(useProviderStore.getState().activeId).toBe('saved-deepseek')
    expect(useTabStore.getState().tabs).toEqual([])
  })
})
