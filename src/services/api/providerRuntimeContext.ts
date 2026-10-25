import { AsyncLocalStorage } from 'node:async_hooks'

export type ProviderRuntimeContext = {
  providerId: string
  runtimeKind: 'anthropic_compatible' | 'claude_oauth' | 'openai_oauth' | 'grok_oauth' | 'deepseek_oauth'
  /** A complete, sanitized environment snapshot, never an overlay on a parent provider. */
  env: Readonly<NodeJS.ProcessEnv>
  /** Refresh the explicitly selected official account without consulting a parent login. */
  getClaudeOAuthAccessToken?: () => Promise<string | null>
}

const providerRuntimeStorage = new AsyncLocalStorage<ProviderRuntimeContext>()

export function getProviderRuntimeContext(): ProviderRuntimeContext | undefined {
  return providerRuntimeStorage.getStore()
}

export function getProviderRuntimeEnvironment(): Readonly<NodeJS.ProcessEnv> {
  return getProviderRuntimeContext()?.env ?? process.env
}

export function runWithProviderRuntime<T>(runtime: ProviderRuntimeContext, callback: () => T): T {
  return providerRuntimeStorage.run(runtime, callback)
}

/** Bind lazy generator execution, including cancellation, rather than just its creation. */
export function bindProviderRuntimeGenerator<T, TReturn, TNext>(
  runtime: ProviderRuntimeContext,
  iterator: AsyncGenerator<T, TReturn, TNext>,
): AsyncGenerator<T, TReturn, TNext> {
  return {
    next: (...args: [] | [TNext]) => runWithProviderRuntime(runtime, () => iterator.next(...args)),
    return: value => runWithProviderRuntime(runtime, () => iterator.return(value)),
    throw: error => runWithProviderRuntime(runtime, () => iterator.throw(error)),
    [Symbol.asyncIterator]() { return this },
  } as AsyncGenerator<T, TReturn, TNext>
}
