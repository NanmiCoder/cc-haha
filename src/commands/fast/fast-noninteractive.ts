import { CLAUDE_FAST_MODE_SUPPORTED_MODELS_DISPLAY } from '../../shared/claudeFastMode.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  clearFastModeCooldown,
  getFastModeUnavailableReason,
  isFastModeEnabled,
  isFastModeSupportedByModel,
  prefetchFastModeStatus,
} from '../../utils/fastMode.js'
import {
  formatModelPricing,
  getFastModeCostTierForModel,
  getOpus46CostTier,
} from '../../utils/modelCost.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'

export async function call(
  args: string,
  context: ToolUseContext,
): Promise<{ type: 'text'; value: string }> {
  if (!isFastModeEnabled()) {
    return {
      type: 'text',
      value: 'Fast mode is disabled (CLAUDE_CODE_DISABLE_FAST_MODE is set).',
    }
  }

  const normalizedArg = args.trim().toLowerCase()
  if (normalizedArg !== '' && normalizedArg !== 'on' && normalizedArg !== 'off') {
    return {
      type: 'text',
      value: 'Usage: /fast [on|off]',
    }
  }

  const appState = context.getAppState()
  const currentFastMode =
    appState.fastMode === true || getInitialSettings().fastMode === true
  const enable =
    normalizedArg === 'on'
      ? true
      : normalizedArg === 'off'
        ? false
        : !currentFastMode

  if (!enable) {
    clearFastModeCooldown()
    updateSettingsForSource('userSettings', { fastMode: undefined })
    context.setAppState(prev => ({ ...prev, fastMode: false }))
    return {
      type: 'text',
      value: 'Fast mode OFF',
    }
  }

  await prefetchFastModeStatus()
  const unavailableReason = getFastModeUnavailableReason()
  if (unavailableReason) {
    return {
      type: 'text',
      value: `Fast mode unavailable: ${unavailableReason}`,
    }
  }

  const currentModel =
    context.options.mainLoopModel || appState.mainLoopModel || getMainLoopModel()
  if (!isFastModeSupportedByModel(currentModel)) {
    return {
      type: 'text',
      value: `Fast mode is not supported on ${currentModel}. Supported models: ${CLAUDE_FAST_MODE_SUPPORTED_MODELS_DISPLAY}.`,
    }
  }

  clearFastModeCooldown()
  updateSettingsForSource('userSettings', { fastMode: true })
  context.setAppState(prev => ({ ...prev, fastMode: true }))

  const costTier = getFastModeCostTierForModel(currentModel) ?? getOpus46CostTier(true)
  const pricing = formatModelPricing(costTier)
  return {
    type: 'text',
    value: `Fast mode ON · ${pricing}`,
  }
}
