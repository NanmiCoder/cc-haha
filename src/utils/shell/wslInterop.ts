import type { Platform } from '../platform.js'

const WSL_COMMAND_PATTERN = /(^|[\s;&|()<>'"])wsl(?:\.exe)?(?=$|[\s;&|()<>'"])/

export function commandInvokesWsl(command?: string): boolean {
  return WSL_COMMAND_PATTERN.test(command ?? '')
}

export function getWslInteropEnvironmentOverrides({
  platform,
  command,
  shellPrefix,
  currentEnv = process.env,
}: {
  platform: Platform
  command: string
  shellPrefix?: string
  currentEnv?: NodeJS.ProcessEnv
}): Record<string, string> {
  if (platform !== 'windows') return {}
  if (!commandInvokesWsl(command) && !commandInvokesWsl(shellPrefix)) return {}

  return {
    MSYS2_ARG_CONV_EXCL: currentEnv.MSYS2_ARG_CONV_EXCL ?? '*',
    WSL_UTF8: currentEnv.WSL_UTF8 ?? '1',
  }
}
