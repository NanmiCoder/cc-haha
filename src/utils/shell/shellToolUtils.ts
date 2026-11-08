import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { isEnvDefinedFalsy } from '../envUtils.js'
import { getPlatform } from '../platform.js'
import { tryFindGitBashPath } from '../windowsPaths.js'

export const SHELL_TOOL_NAMES: string[] = [BASH_TOOL_NAME, POWERSHELL_TOOL_NAME]

export type ShellToolType = 'bash' | 'powershell'
export type ShellToolAvailability = { bash: boolean; powershell: boolean }

export function resolveShellToolAvailability({
  platform,
  gitBashPath,
  powerShellSetting,
}: {
  platform: ReturnType<typeof getPlatform>
  gitBashPath: string | null
  powerShellSetting: string | undefined
}): ShellToolAvailability {
  if (platform !== 'windows') {
    return { bash: true, powershell: false }
  }

  return {
    bash: gitBashPath !== null,
    powershell: !isEnvDefinedFalsy(powerShellSetting),
  }
}

export function resolveAvailableShellTool({
  preferredShell,
  availability,
  allowFallback = true,
}: {
  preferredShell: ShellToolType
  availability: ShellToolAvailability
  allowFallback?: boolean
}): ShellToolType | null {
  if (availability[preferredShell]) {
    return preferredShell
  }

  if (!allowFallback) {
    return null
  }

  const fallback = preferredShell === 'bash' ? 'powershell' : 'bash'
  return availability[fallback] ? fallback : null
}

export function getShellToolAvailability(): ShellToolAvailability {
  const platform = getPlatform()
  return resolveShellToolAvailability({
    platform,
    gitBashPath: platform === 'windows' ? tryFindGitBashPath() : null,
    powerShellSetting: process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL,
  })
}

/** Windows exposes Bash only when a real Git Bash installation is available. */
export function isBashToolEnabled(): boolean {
  return getShellToolAvailability().bash
}

/** Native Windows commands can use PowerShell directly, alongside Git Bash. */
export function isPowerShellToolEnabled(): boolean {
  return getShellToolAvailability().powershell
}
