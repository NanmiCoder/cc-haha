import { AsyncLocalStorage } from 'async_hooks'

/**
 * A saved provider that serves one Agent's model inside a process whose
 * session runs another provider. `env` is that provider's complete managed env
 * (the same shape a session on it would be spawned with), so a key absent here
 * is unset for the route rather than inherited from the session.
 */
export type ProviderRoute = {
  providerId: string
  providerName: string
  model: string
  env: Readonly<Record<string, string>>
  /**
   * Network proxy for a provider reached directly: a URL, `null` for a direct
   * connection, or absent to keep the session's process proxy (as for routes
   * through the local provider proxy, which applies the provider's own).
   */
  proxyUrl?: string | null
}

// The Agent's route covers its whole run, including nested Agents that
// inherit its model. Requests choose by model: a side query for the session's
// small model inside the same Agent still belongs to the session provider.
const agentRouteStorage = new AsyncLocalStorage<ProviderRoute>()
const requestRouteStorage = new AsyncLocalStorage<ProviderRoute | null>()

function routeModelKey(model: string): string {
  return model.trim().replace(/\[1m\]$/i, '').toLowerCase()
}

export function getAgentProviderRoute(): ProviderRoute | undefined {
  return agentRouteStorage.getStore()
}

export function getProviderRouteForModel(model: string | undefined): ProviderRoute | undefined {
  if (!model) return undefined
  const key = routeModelKey(model)
  const request = requestRouteStorage.getStore()
  if (request && routeModelKey(request.model) === key) return request
  const agent = agentRouteStorage.getStore()
  return agent && routeModelKey(agent.model) === key ? agent : undefined
}

/** The route serving the model request currently being built, if any. */
export function getRequestProviderRoute(): ProviderRoute | undefined {
  return requestRouteStorage.getStore() ?? undefined
}

/** Provider-managed env as seen by the current model request. */
export function readProviderEnv(key: string): string | undefined {
  const route = requestRouteStorage.getStore()
  return route ? route.env[key] : process.env[key]
}

/** Provider-managed env for decisions keyed by a model outside a request. */
export function readProviderEnvForModel(model: string, key: string): string | undefined {
  const route = getProviderRouteForModel(model)
  return route ? route.env[key] : process.env[key]
}

/**
 * AsyncLocalStorage follows whoever resumes a generator, so wrapping the call
 * that creates it is not enough: every step has to run inside the store.
 */
function runGeneratorIn<S, T, R>(
  storage: AsyncLocalStorage<S>,
  store: S,
  generator: AsyncGenerator<T, R>,
): AsyncGenerator<T, R> {
  return (async function* () {
    let done = false
    try {
      while (true) {
        const step = await storage.run(store, () => generator.next())
        if (step.done) {
          done = true
          return step.value
        }
        yield step.value
      }
    } finally {
      if (!done) await storage.run(store, () => generator.return(undefined as R))
    }
  })()
}

/** Run synchronous setup (e.g. timers it schedules) inside an Agent's route. */
export function runWithAgentProviderRoute<T>(route: ProviderRoute | undefined, fn: () => T): T {
  return route ? agentRouteStorage.run(route, fn) : fn()
}

export function withAgentProviderRoute<T, R>(
  route: ProviderRoute | undefined,
  generator: AsyncGenerator<T, R>,
): AsyncGenerator<T, R> {
  return route ? runGeneratorIn(agentRouteStorage, route, generator) : generator
}

export function withRequestProviderRoute<T, R>(
  model: string,
  generator: AsyncGenerator<T, R>,
): AsyncGenerator<T, R> {
  if (!agentRouteStorage.getStore() && !requestRouteStorage.getStore()) return generator
  return runGeneratorIn(requestRouteStorage, getProviderRouteForModel(model) ?? null, generator)
}
