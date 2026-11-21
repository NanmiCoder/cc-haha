import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPENAI_OFFICIAL_PROVIDER_ID } from '../constants/openaiOfficialProvider'
import { useChatStore } from '../stores/chatStore'
import { useProviderStore } from '../stores/providerStore'
import { DRAFT_RUNTIME_SELECTION_KEY, useSessionRuntimeStore } from '../stores/sessionRuntimeStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { executeFastSlashCommand } from './fastModeCommand'

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}:${JSON.stringify(params)}` : key

afterEach(() => {
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useProviderStore.setState(useProviderStore.getInitialState(), true)
  useSessionRuntimeStore.setState(useSessionRuntimeStore.getInitialState(), true)
  useChatStore.setState(useChatStore.getInitialState(), true)
  useUIStore.setState(useUIStore.getInitialState(), true)
  vi.restoreAllMocks()
})

describe('executeFastSlashCommand', () => {
  it('enables and disables Claude fast mode on a supported official model', async () => {
    const setFastMode = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ fastMode: false, setFastMode })
    useSessionRuntimeStore.getState().setSelection(DRAFT_RUNTIME_SELECTION_KEY, {
      providerId: null,
      modelId: 'claude-opus-5-5',
    })

    await executeFastSlashCommand({ mode: 'on', runtimeKey: DRAFT_RUNTIME_SELECTION_KEY, t: t as never })
    expect(setFastMode).toHaveBeenCalledWith(true)
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe('slashCmd.fast.enabled')

    useSettingsStore.setState({ fastMode: true, setFastMode })
    await executeFastSlashCommand({ mode: 'toggle', runtimeKey: DRAFT_RUNTIME_SELECTION_KEY, t: t as never })
    expect(setFastMode).toHaveBeenLastCalledWith(false)
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe('slashCmd.fast.disabled')
  })

  it('refuses enabling fast mode on an unsupported Claude model and shows a warning toast', async () => {
    const setFastMode = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ fastMode: false, setFastMode })
    useSessionRuntimeStore.getState().setSelection(DRAFT_RUNTIME_SELECTION_KEY, {
      providerId: null,
      modelId: 'claude-sonnet-5-5',
    })

    await executeFastSlashCommand({ mode: 'on', runtimeKey: DRAFT_RUNTIME_SELECTION_KEY, t: t as never })
    expect(setFastMode).not.toHaveBeenCalled()
    expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
      type: 'warning',
      message: 'slashCmd.fast.unsupportedModel:{"model":"claude-sonnet-5-5"}',
    })
  })

  it('toggles openAIFastMode when active runtime is OpenAI Official', async () => {
    const setSessionRuntime = vi.fn()
    useChatStore.setState({ setSessionRuntime })
    useSessionRuntimeStore.getState().setSelection('sess-1', {
      providerId: OPENAI_OFFICIAL_PROVIDER_ID,
      modelId: 'gpt-5.4',
      openAIFastMode: false,
    })

    await executeFastSlashCommand({ mode: 'on', runtimeKey: 'sess-1', t: t as never })
    expect(useSessionRuntimeStore.getState().selections['sess-1']?.openAIFastMode).toBe(true)
    expect(setSessionRuntime).toHaveBeenCalledWith('sess-1', expect.objectContaining({ openAIFastMode: true }))
  })

  it('shows usage toast for invalid argument', async () => {
    await executeFastSlashCommand({ mode: 'invalid', runtimeKey: DRAFT_RUNTIME_SELECTION_KEY, t: t as never })
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe('slashCmd.fast.usage')
  })
})
