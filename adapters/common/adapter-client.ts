import {
  resolveAdapterWorkspace,
  type AdapterConfig,
  type AdapterPlatformConfig,
} from './config.js'
import { AdapterHttpClient } from './http-client.js'
import { enqueueInboundPowerActivity } from './inbound-power-activity.js'

export type AdapterWorkspace = {
  httpClient: AdapterHttpClient
  /** Where a new IM session starts. Guaranteed to sit inside the allowed roots. */
  defaultWorkDir: string
  /** Authorized inbound work, including attachment download and queued commands. */
  enqueue: (chatId: string, task: () => Promise<void>) => Promise<void>
}

/**
 * Build the HTTP client and the default work dir for an IM adapter.
 *
 * Every adapter entrypoint goes through here instead of constructing the client
 * itself. The five entrypoints previously repeated the wiring, and all five
 * repeated the same defect (#1191): they passed the default work dir as the only
 * allowed project root, so /projects listed a single project. Keeping the
 * construction in one importable place makes that class of mistake unreachable
 * without editing this file, and makes it testable — the entrypoints boot a live
 * bot on import and cannot be exercised directly.
 */
export function createAdapterClient(
  config: AdapterConfig,
  platformConfig: AdapterPlatformConfig,
): AdapterWorkspace {
  const { defaultWorkDir, allowedProjectRoots } = resolveAdapterWorkspace(config, platformConfig)
  const httpClient = new AdapterHttpClient(config.serverUrl, { allowedProjectRoots })
  return {
    httpClient,
    defaultWorkDir,
    enqueue: (chatId, task) => enqueueInboundPowerActivity(httpClient, chatId, task),
  }
}
