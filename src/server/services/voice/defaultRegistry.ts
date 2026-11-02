import { createDesktopUiVoicePreferencesStore } from './preferencesStore.js'
import { VoiceProviderRegistry } from './registry.js'
import { LOCAL_MODELS, createLocalModelProvider } from './sherpa/index.js'
import type { SpeechProvider } from './types.js'
import { VoiceService, type VoiceServiceOptions } from './voiceService.js'

/**
 * Providers shipped with the server, in catalog order (SenseVoice, the default,
 * first). Adding a local model means adding its spec to `LOCAL_MODELS`; nothing
 * else in the voice service or API changes.
 */
export function createDefaultProviders(): SpeechProvider[] {
  return LOCAL_MODELS.map(spec => createLocalModelProvider(spec))
}

export function createVoiceService(
  providers: SpeechProvider[],
  options: Partial<Omit<VoiceServiceOptions, 'registry'>> = {},
): VoiceService {
  const registry = new VoiceProviderRegistry()
  for (const provider of providers) registry.register(provider)
  // Forward everything the caller passed: an option dropped here would silently
  // fall back to the real transport or the real ~/.claude and ~/.codex paths.
  return new VoiceService({
    ...options,
    registry,
    preferences: options.preferences ?? createDesktopUiVoicePreferencesStore(),
  })
}

let instance: VoiceService | undefined

/** Process-wide service used by the HTTP API. Providers are created on first use. */
export function getVoiceService(): VoiceService {
  instance ??= createVoiceService(createDefaultProviders())
  return instance
}

/** Test seam: drop the cached service so the next call rebuilds it. */
export function resetVoiceServiceForTests(): void {
  instance = undefined
}
