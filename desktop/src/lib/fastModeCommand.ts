import { isClaudeFastModeSupportedModel } from '../../../src/shared/claudeFastMode'
import { OPENAI_OFFICIAL_PROVIDER_ID } from '../constants/openaiOfficialProvider'
import type { TranslationKey } from '../i18n'
import { useChatStore } from '../stores/chatStore'
import { useProviderStore } from '../stores/providerStore'
import { DRAFT_RUNTIME_SELECTION_KEY, useSessionRuntimeStore } from '../stores/sessionRuntimeStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { resolveDefaultRuntimeSelection } from './runtimeSelection'

export type FastSlashMode = 'toggle' | 'on' | 'off' | 'invalid'

type TranslateFn = (key: TranslationKey, params?: Record<string, string | number>) => string

export async function executeFastSlashCommand(options: {
  mode: FastSlashMode
  runtimeKey: string
  t: TranslateFn
}): Promise<void> {
  const { mode, runtimeKey, t } = options
  const addToast = useUIStore.getState().addToast

  if (mode === 'invalid') {
    addToast({ type: 'info', message: t('slashCmd.fast.usage') })
    return
  }

  const settings = useSettingsStore.getState()
  const providerState = useProviderStore.getState()
  const selection =
    useSessionRuntimeStore.getState().selections[runtimeKey] ??
    resolveDefaultRuntimeSelection(
      providerState.activeId,
      settings.activeProviderName,
      providerState.providers,
      settings.currentModel?.id,
    )

  if (selection.providerId === OPENAI_OFFICIAL_PROVIDER_ID) {
    const nextEnabled = mode === 'on' ? true : mode === 'off' ? false : !(selection.openAIFastMode === true)
    const nextSelection = { ...selection, openAIFastMode: nextEnabled }
    useSessionRuntimeStore.getState().setSelection(runtimeKey, nextSelection)
    if (runtimeKey !== DRAFT_RUNTIME_SELECTION_KEY) {
      useChatStore.getState().setSessionRuntime(runtimeKey, nextSelection)
    }
    addToast({
      type: nextEnabled ? 'success' : 'info',
      message: nextEnabled ? t('slashCmd.fast.enabled') : t('slashCmd.fast.disabled'),
    })
    return
  }

  const selectedProvider = selection.providerId
    ? providerState.providers.find((provider) => provider.id === selection.providerId) ?? null
    : null
  const isAnthropicEligibleProvider =
    selection.providerId === null ||
    (selectedProvider !== null &&
      (selectedProvider.apiFormat ?? 'anthropic') === 'anthropic' &&
      selectedProvider.disableExperimentalBetas !== true)
  const modelSupportsFast = isAnthropicEligibleProvider && isClaudeFastModeSupportedModel(selection.modelId)

  const currentEnabled = settings.fastMode === true
  const nextEnabled = mode === 'on' ? true : mode === 'off' ? false : !currentEnabled

  if (nextEnabled && !modelSupportsFast) {
    addToast({
      type: 'warning',
      message: t('slashCmd.fast.unsupportedModel', { model: selection.modelId }),
    })
    return
  }

  try {
    await settings.setFastMode(nextEnabled)
    addToast({
      type: nextEnabled ? 'success' : 'info',
      message: nextEnabled ? t('slashCmd.fast.enabled') : t('slashCmd.fast.disabled'),
    })
  } catch {
    addToast({
      type: 'error',
      message: t('slashCmd.fast.saveFailed'),
    })
  }
}
