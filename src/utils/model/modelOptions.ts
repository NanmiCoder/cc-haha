// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { getInitialMainLoopModel } from '../../bootstrap/state.js'
import {
  hasOpenAIAuthLogin,
  isClaudeAISubscriber,
  isMaxSubscriber,
  isOpenAIAuthActive,
  isTeamPremiumSubscriber,
} from '../auth.js'
import { getModelStrings } from './modelStrings.js'
import {
  COST_TIER_10_50,
  COST_TIER_3_15,
  COST_HAIKU_35,
  COST_HAIKU_45,
  formatModelPricing,
} from '../modelCost.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { checkOpus1mAccess, checkSonnet1mAccess } from './check1mAccess.js'
import {
  getAPIProvider,
  hasAnthropicCompatibleThirdPartyConfig,
} from './providers.js'
import { isModelAllowed } from './modelAllowlist.js'
import {
  getCanonicalName,
  getClaudeAiUserDefaultModelDescription,
  getDefaultFableModel,
  getDefaultSonnetModel,
  getDefaultOpusModel,
  getDefaultHaikuModel,
  getDefaultMainLoopModelSetting,
  getMarketingNameForModel,
  getUserSpecifiedModelSetting,
  isOpus1mMergeEnabled,
  getOpus46PricingSuffix,
  renderDefaultModelSetting,
  type ModelSetting,
} from './model.js'
import { has1mContext } from '../context.js'
import { getGlobalConfig } from '../config.js'
import { OPENAI_CODEX_MODEL_CATALOG } from '../../services/openaiAuth/models.js'

// @[MODEL LAUNCH]: Update all the available and default model option strings below.

export type ModelOption = {
  value: ModelSetting
  label: string
  description: string
  descriptionForModel?: string
}

function pushUniqueOption(
  options: ModelOption[],
  option: ModelOption | undefined,
): void {
  if (!option) {
    return
  }

  if (options.some(existing => existing.value === option.value)) {
    return
  }

  options.push(option)
}

function shouldOfferSonnet1mOption(): boolean {
  if (!checkSonnet1mAccess()) {
    return false
  }

  return (
    shouldUseThirdPartyAnthropicOptions() ||
    !getDefaultSonnetModel().toLowerCase().includes('sonnet-5')
  )
}

function shouldUseThirdPartyAnthropicOptions(): boolean {
  return !isClaudeAISubscriber() && hasAnthropicCompatibleThirdPartyConfig()
}

export function getDefaultOptionForUser(fastMode = false): ModelOption {
  if (process.env.USER_TYPE === 'ant') {
    const currentModel = renderDefaultModelSetting(
      getDefaultMainLoopModelSetting(),
    )
    return {
      value: null,
      label: 'Default (recommended)',
      description: `Use the default model for Ants (currently ${currentModel})`,
      descriptionForModel: `Default model (currently ${currentModel})`,
    }
  }

  if (isOpenAIAuthActive()) {
    const currentModel = renderDefaultModelSetting(
      getDefaultMainLoopModelSetting(),
    )
    return {
      value: null,
      label: 'Default (recommended)',
      description: `Use the OpenAI/Codex default model (currently ${currentModel})`,
      descriptionForModel: `OpenAI/Codex default model (currently ${currentModel})`,
    }
  }

  // Subscribers
  if (isClaudeAISubscriber()) {
    return {
      value: null,
      label: 'Default (recommended)',
      description: getClaudeAiUserDefaultModelDescription(fastMode),
    }
  }

  // PAYG
  const is3P = shouldUseThirdPartyAnthropicOptions()
  const currentModel = renderDefaultModelSetting(getDefaultMainLoopModelSetting())
  const pricingSuffix =
    is3P
      ? ''
      : currentModel.includes('Opus')
        ? getOpus46PricingSuffix(fastMode)
        : ` · ${formatModelPricing(COST_TIER_3_15)}`
  return {
    value: null,
    label: 'Default (recommended)',
    description: `Use the default model (currently ${currentModel})${pricingSuffix}`,
  }
}

function getCustomSonnetOption(): ModelOption | undefined {
  const is3P = shouldUseThirdPartyAnthropicOptions()
  const customSonnetModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  // When a 3P user has a custom sonnet model string, show it directly
  if (is3P && customSonnetModel) {
    const is1m = has1mContext(customSonnetModel)
    return {
      value: 'sonnet',
      label:
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME ?? customSonnetModel,
      description:
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION ??
        `Custom Sonnet model${is1m ? ' (1M context)' : ''}`,
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION ?? `Custom Sonnet model${is1m ? ' with 1M context' : ''}`} (${customSonnetModel})`,
    }
  }
}

// @[MODEL LAUNCH]: Update or add model option functions (getSonnetXXOption, getOpusXXOption, etc.)
// with the new model's label and description. These appear in the /model picker.
function getCustomFableOption(): ModelOption | undefined {
  const is3P = shouldUseThirdPartyAnthropicOptions()
  const customFableModel = process.env.ANTHROPIC_DEFAULT_FABLE_MODEL
  if (is3P && customFableModel) {
    const is1m = has1mContext(customFableModel)
    return {
      value: 'fable',
      label:
        process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME ?? customFableModel,
      description:
        process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION ??
        `Custom Fable model${is1m ? ' (1M context)' : ''}`,
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION ?? `Custom Fable model${is1m ? ' with 1M context' : ''}`} (${customFableModel})`,
    }
  }
}

function getFable5Option(): ModelOption | undefined {
  if (shouldUseThirdPartyAnthropicOptions()) {
    return undefined
  }
  return {
    value: 'fable',
    label: 'Fable',
    description: `Fable 5 · Highest capability for long-running tasks · ${formatModelPricing(COST_TIER_10_50)}`,
    descriptionForModel:
      'Fable 5 - highest capability for hard, long-running tasks',
  }
}

function getSonnet46Option(): ModelOption {
  const is3P = shouldUseThirdPartyAnthropicOptions()
  const modelName = is3P ? 'Sonnet 4.6' : 'Sonnet 5'
  return {
    value: is3P ? getModelStrings().sonnet46 : 'sonnet',
    label: 'Sonnet',
    description: `${modelName} · Best for everyday tasks${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
    descriptionForModel:
      `${modelName} - best for everyday tasks. Generally recommended for most coding tasks`,
  }
}

function getCustomOpusOption(): ModelOption | undefined {
  const is3P = shouldUseThirdPartyAnthropicOptions()
  const customOpusModel = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  // When a 3P user has a custom opus model string, show it directly
  if (is3P && customOpusModel) {
    const is1m = has1mContext(customOpusModel)
    return {
      value: 'opus',
      label: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME ?? customOpusModel,
      description:
        process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION ??
        `Custom Opus model${is1m ? ' (1M context)' : ''}`,
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION ?? `Custom Opus model${is1m ? ' with 1M context' : ''}`} (${customOpusModel})`,
    }
  }
}

function getOpus41Option(): ModelOption {
  return {
    value: 'opus',
    label: 'Opus 4.1',
    description: `Opus 4.1 · Legacy`,
    descriptionForModel: 'Opus 4.1 - legacy version',
  }
}

function getOpus46Option(fastMode = false): ModelOption {
  const is3P = shouldUseThirdPartyAnthropicOptions()
  return {
    value: is3P ? getModelStrings().opus46 : 'opus',
    label: 'Opus',
    description: `${is3P ? 'Opus 4.7' : 'Opus 4.8'} · Most capable for complex work${getOpus46PricingSuffix(fastMode)}`,
    descriptionForModel: `${is3P ? 'Opus 4.7' : 'Opus 4.8'} - most capable for complex work`,
  }
}

export function getSonnet46_1MOption(): ModelOption {
  const is3P = shouldUseThirdPartyAnthropicOptions()
  const modelName = is3P ? 'Sonnet 4.6' : 'Sonnet 5'
  return {
    value: is3P ? getModelStrings().sonnet46 + '[1m]' : 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `${modelName} for long sessions${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
    descriptionForModel:
      `${modelName} with 1M context window - for long sessions with large codebases`,
  }
}

export function getOpus46_1MOption(fastMode = false): ModelOption {
  const is3P = shouldUseThirdPartyAnthropicOptions()
  const modelName = is3P ? 'Opus 4.7' : 'Opus 4.8'
  return {
    value: is3P ? getModelStrings().opus46 + '[1m]' : 'opus[1m]',
    label: 'Opus (1M context)',
    description: `${modelName} for long sessions${getOpus46PricingSuffix(fastMode)}`,
    descriptionForModel:
      `${modelName} with 1M context window - for long sessions with large codebases`,
  }
}

function getCustomHaikuOption(): ModelOption | undefined {
  const is3P = shouldUseThirdPartyAnthropicOptions()
  const customHaikuModel = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  // When a 3P user has a custom haiku model string, show it directly
  if (is3P && customHaikuModel) {
    return {
      value: 'haiku',
      label: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME ?? customHaikuModel,
      description:
        process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION ??
        'Custom Haiku model',
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION ?? 'Custom Haiku model'} (${customHaikuModel})`,
    }
  }
}

function getHaiku45Option(): ModelOption {
  const is3P = shouldUseThirdPartyAnthropicOptions()
  return {
    value: 'haiku',
    label: 'Haiku',
    description: `Haiku 4.5 · Fastest for quick answers${is3P ? '' : ` · ${formatModelPricing(COST_HAIKU_45)}`}`,
    descriptionForModel:
      'Haiku 4.5 - fastest for quick answers. Lower cost but less capable than Sonnet 4.6.',
  }
}

function getHaiku35Option(): ModelOption {
  const is3P = shouldUseThirdPartyAnthropicOptions()
  return {
    value: 'haiku',
    label: 'Haiku',
    description: `Haiku 3.5 for simple tasks${is3P ? '' : ` · ${formatModelPricing(COST_HAIKU_35)}`}`,
    descriptionForModel:
      'Haiku 3.5 - faster and lower cost, but less capable than Sonnet. Use for simple tasks.',
  }
}

function getHaikuOption(): ModelOption {
  // Return correct Haiku option based on provider
  const haikuModel = getDefaultHaikuModel()
  return haikuModel === getModelStrings().haiku45
    ? getHaiku45Option()
    : getHaiku35Option()
}

function getMaxOpusOption(fastMode = false): ModelOption {
  return {
    value: 'opus',
    label: 'Opus',
    description: `Opus 4.8 · Most capable for complex work${fastMode ? getOpus46PricingSuffix(true) : ''}`,
  }
}

export function getMaxSonnet46_1MOption(): ModelOption {
  const is3P = shouldUseThirdPartyAnthropicOptions()
  const billingInfo = isClaudeAISubscriber() ? ' · Billed as extra usage' : ''
  return {
    value: 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `Sonnet 5 with 1M context${billingInfo}${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
  }
}

export function getMaxOpus46_1MOption(fastMode = false): ModelOption {
  const billingInfo = isClaudeAISubscriber() ? ' · Billed as extra usage' : ''
  return {
    value: 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 4.8 with 1M context${billingInfo}${getOpus46PricingSuffix(fastMode)}`,
  }
}

function getMergedOpus1MOption(fastMode = false): ModelOption {
  const is3P = shouldUseThirdPartyAnthropicOptions()
  return {
    value: is3P ? getModelStrings().opus46 + '[1m]' : 'opus[1m]',
    label: 'Opus (1M context)',
    description: `${is3P ? 'Opus 4.7' : 'Opus 4.8'} with 1M context · Most capable for complex work${!is3P && fastMode ? getOpus46PricingSuffix(fastMode) : ''}`,
    descriptionForModel:
      `${is3P ? 'Opus 4.7' : 'Opus 4.8'} with 1M context - most capable for complex work`,
  }
}

const MaxSonnet46Option: ModelOption = {
  value: 'sonnet',
  label: 'Sonnet',
  description: 'Sonnet 5 · Best for everyday tasks',
}

const MaxHaiku45Option: ModelOption = {
  value: 'haiku',
  label: 'Haiku',
  description: 'Haiku 4.5 · Fastest for quick answers',
}

function getOpusPlanOption(): ModelOption {
  return {
    value: 'opusplan',
    label: 'Opus Plan Mode',
    description: 'Use Opus in plan mode, Sonnet otherwise',
  }
}

function getAzureOpenAICodexOption(): ModelOption {
  return {
    value: 'gpt-5.2-codex',
    label: 'GPT-5.2 Codex',
    description: 'Azure OpenAI Codex model',
    descriptionForModel: 'GPT-5.2 Codex via Azure OpenAI',
  }
}

function getAzureOpenAICodexOptions(): ModelOption[] {
  return [
    {
      value: 'gpt-5.2-codex',
      label: 'GPT-5.2 Codex',
      description: 'Azure OpenAI Codex model',
    },
    {
      value: 'gpt-5.3-codex',
      label: 'GPT-5.3 Codex',
      description: 'Azure OpenAI Codex model',
    },
    {
      value: 'gpt-5.4-codex',
      label: 'GPT-5.4 Codex',
      description: 'Azure OpenAI Codex model',
    },
  ]
}

function getOpenAIModelOptions(): ModelOption[] {
  const options = [
    getDefaultOptionForUser(),
    ...OPENAI_CODEX_MODEL_CATALOG.map(model => ({
      value: model.value,
      label: model.label,
      description: model.description,
      descriptionForModel: model.descriptionForModel,
    })),
  ]

  if (!shouldUseThirdPartyAnthropicOptions()) {
    return options
  }

  pushUniqueOption(options, getCustomSonnetOption())
  pushUniqueOption(options, getCustomFableOption())
  pushUniqueOption(options, getCustomOpusOption())
  pushUniqueOption(options, getCustomHaikuOption())

  return options
}
// @[MODEL LAUNCH]: Update the model picker lists below to include/reorder options for the new model.
// Each user tier (ant, Max/Team Premium, Pro/Team Standard/Enterprise, PAYG 1P, PAYG 3P) has its own list.
function getModelOptionsBase(fastMode = false): ModelOption[] {
  if (getAPIProvider() === 'azureOpenAI') {
    return [getDefaultOptionForUser(), ...getAzureOpenAICodexOptions()]
  }

  if (process.env.USER_TYPE === 'ant') {
    // Build options from antModels config
    const antModelOptions: ModelOption[] = getAntModels().map(m => ({
      value: m.alias,
      label: m.label,
      description: m.description ?? `[ANT-ONLY] ${m.label} (${m.model})`,
    }))

    const fableOption = getFable5Option()
    return [
      getDefaultOptionForUser(),
      ...(fableOption ? [fableOption] : []),
      ...antModelOptions,
      getMergedOpus1MOption(fastMode),
      getSonnet46Option(),
      getSonnet46_1MOption(),
      getHaiku45Option(),
    ]
  }

  if (hasOpenAIAuthLogin()) {
    return getOpenAIModelOptions(fastMode)
  }

  if (isClaudeAISubscriber()) {
    if (isMaxSubscriber() || isTeamPremiumSubscriber()) {
      // Max and Team Premium users: Opus is default, show Sonnet as alternative
      const premiumOptions = [getDefaultOptionForUser(fastMode)]
      pushUniqueOption(premiumOptions, getFable5Option())
      if (!isOpus1mMergeEnabled() && checkOpus1mAccess()) {
        premiumOptions.push(getMaxOpus46_1MOption(fastMode))
      }

      premiumOptions.push(MaxSonnet46Option)
      if (shouldOfferSonnet1mOption()) {
        premiumOptions.push(getMaxSonnet46_1MOption())
      }

      premiumOptions.push(MaxHaiku45Option)
      return premiumOptions
    }

    // Pro/Team Standard/Enterprise users: Sonnet is default, show Opus as alternative
    const standardOptions = [getDefaultOptionForUser(fastMode)]
    pushUniqueOption(standardOptions, getFable5Option())
    if (shouldOfferSonnet1mOption()) {
      standardOptions.push(getMaxSonnet46_1MOption())
    }

    if (isOpus1mMergeEnabled()) {
      standardOptions.push(getMergedOpus1MOption(fastMode))
    } else {
      standardOptions.push(getMaxOpusOption(fastMode))
      if (checkOpus1mAccess()) {
        standardOptions.push(getMaxOpus46_1MOption(fastMode))
      }
    }

    standardOptions.push(MaxHaiku45Option)
    return standardOptions
  }

  // PAYG 1P API: Default (Opus 4.8) + Fable + Sonnet + Haiku.
  // Opus 4.8 and Sonnet 5 already have native 1M context windows.
  if (!shouldUseThirdPartyAnthropicOptions()) {
    const payg1POptions = [getDefaultOptionForUser(fastMode)]
    pushUniqueOption(payg1POptions, getFable5Option())
    payg1POptions.push(getSonnet46Option())
    if (shouldOfferSonnet1mOption()) {
      payg1POptions.push(getSonnet46_1MOption())
    }
    payg1POptions.push(getHaiku45Option())
    return payg1POptions
  }

  // PAYG 3P: Default (Sonnet 4.5) + optional custom Fable + Sonnet + Opus + Haiku
  const payg3pOptions = [getDefaultOptionForUser(fastMode)]

  pushUniqueOption(payg3pOptions, getCustomFableOption())

  const customSonnet = getCustomSonnetOption()
  if (customSonnet !== undefined) {
    pushUniqueOption(payg3pOptions, customSonnet)
  } else {
    // Add Sonnet 4.6 since Sonnet 4.5 is the third-party default
    payg3pOptions.push(getSonnet46Option())
    if (shouldOfferSonnet1mOption()) {
      payg3pOptions.push(getSonnet46_1MOption())
    }
  }

  const customOpus = getCustomOpusOption()
  if (customOpus !== undefined) {
    pushUniqueOption(payg3pOptions, customOpus)
  } else {
    // Add Opus 4.1, Opus 4.7 and Opus 4.7 1M
    payg3pOptions.push(getOpus41Option()) // This is the default opus
    payg3pOptions.push(getOpus46Option(fastMode))
    if (checkOpus1mAccess()) {
      payg3pOptions.push(getOpus46_1MOption(fastMode))
    }
  }
  const customHaiku = getCustomHaikuOption()
  if (customHaiku !== undefined) {
    pushUniqueOption(payg3pOptions, customHaiku)
  } else {
    payg3pOptions.push(getHaikuOption())
  }
  return payg3pOptions
}

// @[MODEL LAUNCH]: Add the new model ID to the appropriate family pattern below
// so the "newer version available" hint works correctly.
/**
 * Map a full model name to its family alias and the marketing name of the
 * version the alias currently resolves to. Used to detect when a user has
 * a specific older version pinned and a newer one is available.
 */
function getModelFamilyInfo(
  model: string,
): { alias: string; currentVersionName: string } | null {
  const canonical = getCanonicalName(model)

  // Fable family
  if (canonical.includes('claude-fable-5')) {
    const defaultModel = getDefaultFableModel()
    // The alias can lag a newly selectable release; a different version is not
    // necessarily an upgrade for a user who has already pinned Fable 5.1.
    if (
      canonical === 'claude-fable-5-1' &&
      getCanonicalName(defaultModel) === 'claude-fable-5'
    ) {
      return null
    }
    const currentName = getMarketingNameForModel(defaultModel)
    if (currentName) {
      return { alias: 'Fable', currentVersionName: currentName }
    }
  }

  // Sonnet family
  if (
    canonical.includes('claude-sonnet-5') ||
    canonical.includes('claude-sonnet-4-6') ||
    canonical.includes('claude-sonnet-4-5') ||
    canonical.includes('claude-sonnet-4-') ||
    canonical.includes('claude-3-7-sonnet') ||
    canonical.includes('claude-3-5-sonnet')
  ) {
    const currentName = getMarketingNameForModel(getDefaultSonnetModel())
    if (currentName) {
      return { alias: 'Sonnet', currentVersionName: currentName }
    }
  }

  // Opus family
  if (canonical.includes('claude-opus-4')) {
    const currentName = getMarketingNameForModel(getDefaultOpusModel())
    if (currentName) {
      return { alias: 'Opus', currentVersionName: currentName }
    }
  }

  // Haiku family
  if (
    canonical.includes('claude-haiku') ||
    canonical.includes('claude-3-5-haiku')
  ) {
    const currentName = getMarketingNameForModel(getDefaultHaikuModel())
    if (currentName) {
      return { alias: 'Haiku', currentVersionName: currentName }
    }
  }

  return null
}

/**
 * Returns a ModelOption for a known Anthropic model with a human-readable
 * label, and an upgrade hint if a newer version is available via the alias.
 * Returns null if the model is not recognized.
 */
function getKnownModelOption(model: string): ModelOption | null {
  const marketingName = getMarketingNameForModel(model)
  if (!marketingName) return null

  const familyInfo = getModelFamilyInfo(model)
  if (!familyInfo) {
    return {
      value: model,
      label: marketingName,
      description: model,
    }
  }

  // Check if the alias currently resolves to a different (newer) version
  if (marketingName !== familyInfo.currentVersionName) {
    return {
      value: model,
      label: marketingName,
      description: `Newer version available · select ${familyInfo.alias} for ${familyInfo.currentVersionName}`,
    }
  }

  // Same version as the alias — just show the friendly name
  return {
    value: model,
    label: marketingName,
    description: model,
  }
}

export function getModelOptions(fastMode = false): ModelOption[] {
  const options = getModelOptionsBase(fastMode)

  // Add the custom model from the ANTHROPIC_CUSTOM_MODEL_OPTION env var
  const envCustomModel = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  if (
    envCustomModel &&
    !options.some(existing => existing.value === envCustomModel)
  ) {
    options.push({
      value: envCustomModel,
      label: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME ?? envCustomModel,
      description:
        process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION ??
        `Custom model (${envCustomModel})`,
    })
  }

  // Append additional model options fetched during bootstrap
  for (const opt of getGlobalConfig().additionalModelOptionsCache ?? []) {
    if (!options.some(existing => existing.value === opt.value)) {
      options.push(opt)
    }
  }

  // Add custom model from either the current model value or the initial one
  // if it is not already in the options.
  let customModel: ModelSetting = null
  const currentMainLoopModel = getUserSpecifiedModelSetting()
  const initialMainLoopModel = getInitialMainLoopModel()
  if (currentMainLoopModel !== undefined && currentMainLoopModel !== null) {
    customModel = currentMainLoopModel
  } else if (initialMainLoopModel !== null) {
    customModel = initialMainLoopModel
  }
  if (customModel === null || options.some(opt => opt.value === customModel)) {
    return filterModelOptionsByAllowlist(options)
  } else if (customModel === 'opusplan') {
    return filterModelOptionsByAllowlist([...options, getOpusPlanOption()])
  } else if (customModel === 'opus' && getAPIProvider() === 'firstParty') {
    return filterModelOptionsByAllowlist([
      ...options,
      getMaxOpusOption(fastMode),
    ])
  } else if (customModel === 'opus[1m]' && getAPIProvider() === 'firstParty') {
    return filterModelOptionsByAllowlist([
      ...options,
      getMergedOpus1MOption(fastMode),
    ])
  } else {
    // Try to show a human-readable label for known Anthropic models, with an
    // upgrade hint if the alias now resolves to a newer version.
    const knownOption = getKnownModelOption(customModel)
    if (knownOption) {
      options.push(knownOption)
    } else {
      options.push({
        value: customModel,
        label: customModel,
        description: 'Custom model',
      })
    }
    return filterModelOptionsByAllowlist(options)
  }
}

/**
 * Filter model options by the availableModels allowlist.
 * Always preserves the "Default" option (value: null).
 */
function filterModelOptionsByAllowlist(options: ModelOption[]): ModelOption[] {
  const settings = getSettings_DEPRECATED() || {}
  if (!settings.availableModels) {
    return options // No restrictions
  }
  return options.filter(
    opt =>
      opt.value === null || (opt.value !== null && isModelAllowed(opt.value)),
  )
}
