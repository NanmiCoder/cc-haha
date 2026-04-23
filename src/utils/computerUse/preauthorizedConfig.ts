import type { CuGrantFlags } from '../../vendor/computer-use-mcp/types.js'

export type StoredAuthorizedApp = {
  bundleId: string
  displayName: string
}

export type StoredComputerUseConfig = {
  authorizedApps?: StoredAuthorizedApp[]
  grantFlags?: Partial<CuGrantFlags>
}

export const DEFAULT_DESKTOP_GRANT_FLAGS: CuGrantFlags = {
  clipboardRead: true,
  clipboardWrite: true,
  systemKeyCombos: true,
}

export function resolveStoredComputerUseConfig(
  config?: StoredComputerUseConfig,
): {
  authorizedApps: StoredAuthorizedApp[]
  grantFlags: CuGrantFlags
} {
  return {
    authorizedApps: config?.authorizedApps ?? [],
    grantFlags: {
      ...DEFAULT_DESKTOP_GRANT_FLAGS,
      ...(config?.grantFlags ?? {}),
    },
  }
}

