import path from 'node:path'

export type SidecarMode = 'server' | 'cli' | 'agent-sdk' | 'adapters'

const EXPLICIT_MODES = new Set<SidecarMode>(['server', 'cli', 'agent-sdk', 'adapters'])
const DESKTOP_CLI_NAMES = new Set(['claude-haha', 'claude-haha.exe'])

export function resolveSidecarInvocation(
  rawArgs: string[],
  execPath: string = process.execPath,
  envAppRoot: string | null = process.env.CLAUDE_APP_ROOT ?? null,
): {
  mode: SidecarMode | null
  restArgs: string[]
  defaultAppRoot: string | null
} {
  const explicitMode = rawArgs[0]
  if (explicitMode && EXPLICIT_MODES.has(explicitMode as SidecarMode)) {
    return {
      mode: explicitMode as SidecarMode,
      restArgs: rawArgs.slice(1),
      defaultAppRoot: envAppRoot,
    }
  }

  const execName = path.basename(execPath).toLowerCase()
  if (DESKTOP_CLI_NAMES.has(execName)) {
    return {
      mode: 'cli',
      restArgs: rawArgs,
      defaultAppRoot: envAppRoot ?? path.dirname(execPath),
    }
  }

  return {
    mode: null,
    restArgs: rawArgs,
    defaultAppRoot: envAppRoot,
  }
}

export function parseLauncherArgs(
  rawArgs: string[],
  defaultAppRoot: string | null = process.env.CLAUDE_APP_ROOT ?? null,
): { appRoot: string; args: string[] } {
  const nextArgs: string[] = []
  let appRoot: string | null = defaultAppRoot

  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index]
    if (arg === '--app-root') {
      appRoot = rawArgs[index + 1] ?? null
      index += 1
      continue
    }
    nextArgs.push(arg!)
  }

  if (!appRoot) {
    throw new Error('Missing --app-root for claude-sidecar')
  }

  return { appRoot, args: nextArgs }
}
