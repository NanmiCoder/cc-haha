import { useEffect, useState } from 'react'
import type { ApiClient } from '../../core/client'
import { normalizeConnectors } from '../../core/connectors'
import { normalizeAgents, normalizeWorkflows, type BringExtrasData } from './bringModel'

/** null means this category is unavailable (endpoint not allowed, computer unsupported, network error): the corresponding entry row is simply hidden. */
export type BringExtras = BringExtrasData
const none: BringExtras = { agents: null, connectors: null, workflows: null }

type Getter = Pick<ApiClient, 'get'>

/**
 * The three directories are each read once independently: one failing only makes itself null.
 * Notify after each one finishes reading, so whichever arrives first shows first.
 */
export function loadBringExtras(
  client: Getter,
  workDir: string | undefined,
  signal: AbortSignal,
  onPart: <K extends keyof BringExtras>(key: K, value: BringExtras[K]) => void
): Promise<unknown> {
  const options = { signal }
  const cwd = workDir ? `?cwd=${encodeURIComponent(workDir)}` : ''
  const settle = <K extends keyof BringExtras>(key: K, path: string, normalize: (value: unknown) => BringExtras[K]) =>
    client
      .get<unknown>(path, options)
      .then(normalize, () => null as BringExtras[K])
      .then((value) => {
        if (!signal.aborted) onPart(key, value)
      })
  return Promise.all([
    settle('agents', `/api/agents${cwd}`, normalizeAgents),
    settle('connectors', '/api/connectors', normalizeConnectors),
    settle('workflows', `/api/workflows${cwd}`, normalizeWorkflows),
  ])
}

/**
 * Directories for connectors, agents and workflows. The server only allows read-only lists for remote phones, 
 * and older desktop versions may lack these endpoints, so each is read every time the sheet opens, shown on success, treated as absent on failure.
 */
export function useBringExtras(client: ApiClient | null, workDir: string | undefined, active: boolean) {
  const [extras, setExtras] = useState<BringExtras>(none)
  useEffect(() => {
    if (!client || !active) return
    const controller = new AbortController()
    void loadBringExtras(client, workDir, controller.signal, (key, value) =>
      setExtras((previous) => ({ ...previous, [key]: value }))
    )
    return () => controller.abort()
  }, [client, workDir, active])
  return client ? extras : none
}
