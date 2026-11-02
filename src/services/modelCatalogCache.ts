/**
 * Shared caching strategy for provider model catalogs.
 *
 * A model catalog only decides which rows appear in the model picker, so a
 * refresh must never be a precondition for anything the user is waiting on.
 * The desktop shell learned this the hard way: `/api/models` sits inside the
 * `settingsStore.fetchAll` gate that blocks the first paint, so an unreachable
 * upstream turned every cold start into a full request timeout before the UI
 * would render — and the value finally handed back was the bundled fallback
 * that was available for free all along.
 *
 * So the default path is stale-while-revalidate: answer immediately from cache
 * (even expired) or from the bundled fallback, and refresh in the background.
 * A failed refresh is remembered for `failureBackoffMs`, otherwise every call
 * pays the upstream timeout again. `forceRefresh` keeps the blocking semantics
 * for callers that explicitly asked for fresh data.
 */

export interface ModelCatalogCacheOptions<T = unknown> {
  /** How long a successful refresh stays authoritative. */
  ttlMs: number
  /** How long to stop retrying after a failed refresh. */
  failureBackoffMs: number
  /** Publish only the currently selected account's accepted catalog, including its initial fallback. */
  onChange?: (models: T) => void
}

export interface ResolveCatalogInput<T> {
  /** Identity the cache is keyed on; a different account must not reuse the entry. */
  accountKey: string
  /** Performs the upstream request. Only ever called by this cache. */
  fetchCatalog: () => Promise<T>
  /** Bundled catalog served while nothing better is available. */
  fallback: T
  /** Await the upstream request instead of refreshing in the background. */
  forceRefresh?: boolean
  /** An explicit user refresh must report failures instead of claiming fallback data is fresh. */
  throwOnError?: boolean
}

export interface ModelCatalogCache<T> {
  resolve(input: ResolveCatalogInput<T>): Promise<T>
  /** Drops the cached entry and any failure backoff. */
  clear(): void
}

export function createModelCatalogCache<T>(
  { ttlMs, failureBackoffMs, onChange }: ModelCatalogCacheOptions<T>,
): ModelCatalogCache<T> {
  let cached: { accountKey: string; expiresAt: number; models: T } | null = null
  let inFlight: Promise<T> | null = null
  let retryAfter = 0
  let activeAccountKey: string | null = null
  let revision = 0

  const store = (accountKey: string, models: T) => {
    cached = { accountKey, expiresAt: Date.now() + ttlMs, models }
    retryAfter = 0
    onChange?.(models)
  }

  const revalidate = (accountKey: string, fetchCatalog: () => Promise<T>): Promise<T> => {
    // Callers arrive in bursts (`/api/models` and `/api/models/current` are
    // requested in the same tick), so a single refresh serves all of them.
    if (inFlight) return inFlight
    const requestRevision = revision
    inFlight = Promise.resolve().then(fetchCatalog)
      .then((models) => {
        if (requestRevision === revision) store(accountKey, models)
        return models
      })
      .catch((error) => {
        if (requestRevision === revision) retryAfter = Date.now() + failureBackoffMs
        throw error
      })
      .finally(() => {
        if (requestRevision === revision) inFlight = null
      })
    return inFlight
  }

  return {
    async resolve({ accountKey, fetchCatalog, fallback, forceRefresh, throwOnError }) {
      if (activeAccountKey !== accountKey) {
        activeAccountKey = accountKey
        revision += 1
        cached = null
        inFlight = null
        retryAfter = 0
        onChange?.(fallback)
      }
      if (forceRefresh) {
        // A refresh supersedes any earlier request, including a startup fetch
        // still in flight. Its late response must not restore an older listing.
        revision += 1
        inFlight = null
        try {
          return await revalidate(accountKey, fetchCatalog)
        } catch (error) {
          if (throwOnError) throw error
          // The last listing this account got still beats the bundled catalog.
          return cached?.accountKey === accountKey ? cached.models : fallback
        }
      }

      const usable = cached?.accountKey === accountKey ? cached : null
      if (usable && usable.expiresAt > Date.now()) return usable.models

      if (Date.now() >= retryAfter) {
        void revalidate(accountKey, fetchCatalog).catch(() => {})
      }
      // Stale data still beats the bundled fallback for the account in question.
      return usable ? usable.models : fallback
    },

    clear() {
      revision += 1
      activeAccountKey = null
      cached = null
      inFlight = null
      retryAfter = 0
    },
  }
}
