import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CuGrantFlags } from '../../vendor/computer-use-mcp/types.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'

export type StoredAuthorizedApp = {
  bundleId: string
  displayName: string
  authorizedAt?: string
}

export type StoredComputerUseConfig = {
  enabled?: boolean
  authorizedApps?: StoredAuthorizedApp[]
  grantFlags?: Partial<CuGrantFlags>
}

export const DEFAULT_COMPUTER_USE_ENABLED = true

export const DEFAULT_DESKTOP_GRANT_FLAGS: CuGrantFlags = {
  clipboardRead: true,
  clipboardWrite: true,
  systemKeyCombos: true,
}

export function getComputerUseConfigPath(): string {
  return join(
    getClaudeConfigHomeDir(),
    'cc-haha',
    'computer-use-config.json',
  )
}

export function resolveStoredComputerUseConfig(
  config?: StoredComputerUseConfig,
): {
  enabled: boolean
  authorizedApps: StoredAuthorizedApp[]
  grantFlags: CuGrantFlags
} {
  return {
    enabled: config?.enabled ?? DEFAULT_COMPUTER_USE_ENABLED,
    authorizedApps: config?.authorizedApps ?? [],
    grantFlags: {
      ...DEFAULT_DESKTOP_GRANT_FLAGS,
      ...(config?.grantFlags ?? {}),
    },
  }
}

export async function loadStoredComputerUseConfig(): Promise<
  ReturnType<typeof resolveStoredComputerUseConfig>
> {
  try {
    const raw = await readFile(getComputerUseConfigPath(), 'utf8')
    return resolveStoredComputerUseConfig(JSON.parse(raw))
  } catch {
    return resolveStoredComputerUseConfig()
  }
}

export async function saveStoredComputerUseConfig(
  config: StoredComputerUseConfig,
): Promise<void> {
  const configPath = getComputerUseConfigPath()
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8')
}
