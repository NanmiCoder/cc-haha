import { CLAUDE_OPUS_4_6_CONFIG, CLAUDE_OPUS_4_8_CONFIG } from '../model/configs.js'
import { getAPIProvider } from '../model/providers.js'

// @[MODEL LAUNCH]: Update the fallback model below.
// When the user has never set teammateDefaultModel in /config, new teammates
// use the current Opus default. Honor ANTHROPIC_DEFAULT_OPUS_MODEL first so a
// mapped third-party provider (cc-switch DeepSeek, etc.) is not rewritten to a
// first-party Opus ID that the upstream then bills as its most expensive model.
// Bedrock/Vertex/Foundry still get a conservative provider ID.
export function getHardcodedTeammateModelFallback(): string {
  const mappedOpus = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL?.trim()
  if (mappedOpus) return mappedOpus

  const provider = getAPIProvider()
  return provider === 'firstParty'
    ? CLAUDE_OPUS_4_8_CONFIG.firstParty
    : CLAUDE_OPUS_4_6_CONFIG[provider]
}
