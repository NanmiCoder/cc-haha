export type SessionApiFormat = 'anthropic' | 'openai_chat' | 'openai_responses'
export type SessionProtocolState = SessionApiFormat | 'mixed' | 'unknown'

export function isSessionApiFormat(value: unknown): value is SessionApiFormat {
  return value === 'anthropic' || value === 'openai_chat' || value === 'openai_responses'
}

/** Resolve the upstream wire protocol, never the model name or internal envelope. */
export function resolveProviderApiFormat(
  providerId: string | null | undefined,
  provider?: { apiFormat?: string; runtimeKind?: string },
): SessionApiFormat | undefined {
  if (providerId === null || providerId === 'claude-official') return 'anthropic'
  if (providerId === 'openai-official' || providerId === 'grok-official') return 'openai_responses'
  if (!provider) return undefined
  if (provider.runtimeKind === 'openai_oauth' || provider.runtimeKind === 'grok_oauth') {
    return 'openai_responses'
  }
  if (provider.apiFormat === undefined) return 'anthropic'
  return isSessionApiFormat(provider.apiFormat) ? provider.apiFormat : undefined
}
