import { readFileSync } from 'fs'

import { getChicagoEnabled } from './gates.js'
import {
  getComputerUseConfigPath,
  resolveStoredComputerUseConfig,
  type StoredComputerUseConfig,
} from './preauthorizedConfig.js'

/**
 * Is Computer Use turned on by the user right now?
 *
 * Gates whether the `computer-use` skill exists at all. Guidance for operating
 * the user's desktop has no business appearing in the session of someone who
 * deliberately switched the feature off — that switch is the whole reason the
 * guidance lives in a skill instead of MCP server instructions, which would sit
 * in every prompt for as long as the server is connected.
 *
 * Synchronous on purpose: skill registration decides visibility during startup
 * and per slash-menu render, where there is nowhere to await. The read is a
 * single small JSON file and is cached for a short window so an open menu does
 * not stat the disk on every keystroke.
 *
 * When the config cannot be read it follows the app-wide default rather than
 * hiding: the tools are registered on that same default, and guidance must
 * never be absent where the tools are present.
 */
const CACHE_TTL_MS = 3_000

let cachedValue: boolean | undefined
let cachedAt = 0

export function isComputerUseSkillEnabled(
  now: number = Date.now(),
  readConfigFile: (path: string) => string = path => readFileSync(path, 'utf8'),
): boolean {
  if (cachedValue !== undefined && now - cachedAt < CACHE_TTL_MS) {
    return cachedValue
  }
  const value = computeEnabled(readConfigFile)
  cachedValue = value
  cachedAt = now
  return value
}

/** Drop the cache so a settings change takes effect without a restart. */
export function invalidateComputerUseSkillGate(): void {
  cachedValue = undefined
  cachedAt = 0
}

function computeEnabled(readConfigFile: (path: string) => string): boolean {
  // The native semantic engine runs on macOS; Windows and Linux use the
  // pixel-tool face backed by the packaged Python helper.
  if (
    process.platform !== 'darwin'
    && process.platform !== 'win32'
    && process.platform !== 'linux'
  ) {
    return false
  }

  // Respect the kill switch before reading anything the user set: when the
  // feature is force-disabled its tools are not registered either, so guidance
  // for them would be pure noise.
  if (!getChicagoEnabled()) return false

  try {
    const raw = readConfigFile(getComputerUseConfigPath())
    const parsed = JSON.parse(raw) as StoredComputerUseConfig
    return resolveStoredComputerUseConfig(parsed).enabled
  } catch {
    // No readable config: fall back to the SAME default the rest of the app
    // uses (`resolveStoredComputerUseConfig(undefined)`), not to `false`.
    //
    // Getting this backwards is worse than it looks. The default is enabled, so
    // a user who has never opened the Settings page already has the ten
    // Computer Use tools registered — hiding the skill there produces the one
    // combination that cannot work: tools present, the workflow they assume
    // absent. That is precisely the failure this skill exists to prevent.
    return resolveStoredComputerUseConfig().enabled
  }
}
