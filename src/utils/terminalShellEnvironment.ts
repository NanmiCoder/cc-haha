import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { isEnvTruthy } from './envUtils.js'
import { logForDebugging } from './debug.js'

const TERMINAL_SHELL_ENV_TIMEOUT_MS = 5000
const TERMINAL_ENV_MARKER = '__CC_HAHA_TERMINAL_ENV_START__'

let cachedTerminalShellEnv:
  | Promise<Record<string, string> | null>
  | undefined

export function toStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function getShellKind(shellPath: string): 'zsh' | 'bash' | null {
  const basename = path.basename(shellPath)
  if (basename.includes('zsh')) return 'zsh'
  if (basename.includes('bash')) return 'bash'
  return null
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function findSupportedShell(
  env: Record<string, string>,
): Promise<string | null> {
  const candidates = [
    env.SHELL,
    '/bin/zsh',
    '/usr/bin/zsh',
    '/bin/bash',
    '/usr/bin/bash',
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const candidate of candidates) {
    if (!getShellKind(candidate)) continue
    if (await isExecutable(candidate)) {
      return candidate
    }
  }

  return null
}

export function mergePathLists(...values: Array<string | undefined>): string | null {
  const seen = new Set<string>()
  const merged: string[] = []

  for (const value of values) {
    for (const entry of (value ?? '').split(path.delimiter)) {
      const trimmed = entry.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      merged.push(trimmed)
    }
  }

  return merged.length > 0 ? merged.join(path.delimiter) : null
}

function parseNullDelimitedEnv(
  stdout: string,
  marker: string,
): Record<string, string> {
  const markerToken = `${marker}\0`
  const markerIndex = stdout.indexOf(markerToken)
  const envOutput =
    markerIndex === -1
      ? stdout
      : stdout.slice(markerIndex + markerToken.length)
  const env: Record<string, string> = {}

  for (const entry of envOutput.split('\0')) {
    if (!entry) continue
    const equals = entry.indexOf('=')
    if (equals <= 0) continue
    env[entry.slice(0, equals)] = entry.slice(equals + 1)
  }

  return env
}

async function captureTerminalShellEnvironment(
  baseEnv: Record<string, string>,
): Promise<Record<string, string> | null> {
  if (
    process.platform === 'win32' ||
    isEnvTruthy(baseEnv.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV) ||
    // Direct terminal launches already inherit shell env; spawning an
    // interactive login shell here can interfere with the active TTY.
    (process.stdin.isTTY && process.stdout.isTTY)
  ) {
    return null
  }

  const shellPath = await findSupportedShell(baseEnv)
  if (!shellPath) {
    return null
  }

  const script = [
    `printf '%s\\0' ${quoteForShell(TERMINAL_ENV_MARKER)}`,
    'env -0',
  ].join('\n')
  const captureEnv = {
    ...baseEnv,
    SHELL: shellPath,
    PS1: '',
    PROMPT: '',
  }
  delete captureEnv.BASH_ENV
  delete captureEnv.ENV

  return await new Promise(resolve => {
    execFile(
      shellPath,
      ['-l', '-i', '-c', script],
      {
        env: captureEnv,
        timeout: TERMINAL_SHELL_ENV_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          logForDebugging(
            `Failed to capture terminal shell environment from ${shellPath}: ${error.message}`,
          )
          resolve(null)
          return
        }

        resolve(parseNullDelimitedEnv(stdout, TERMINAL_ENV_MARKER))
      },
    )
  })
}

export async function getTerminalShellEnvironment(
  baseEnv: Record<string, string> = toStringEnv(process.env),
): Promise<Record<string, string> | null> {
  cachedTerminalShellEnv ??= captureTerminalShellEnvironment(baseEnv)
  return cachedTerminalShellEnv
}

export function mergeTerminalShellEnvironment(
  baseEnv: Record<string, string>,
  shellEnv: Record<string, string> | null,
): Record<string, string> {
  if (!shellEnv) {
    return { ...baseEnv }
  }

  const mergedPath = mergePathLists(shellEnv.PATH, baseEnv.PATH)
  return {
    ...shellEnv,
    ...baseEnv,
    ...(mergedPath ? { PATH: mergedPath } : {}),
  }
}

export async function getProcessEnvWithTerminalShellEnvironment(): Promise<
  Record<string, string>
> {
  const baseEnv = toStringEnv(process.env)
  return mergeTerminalShellEnvironment(
    baseEnv,
    await getTerminalShellEnvironment(baseEnv),
  )
}

export function resetTerminalShellEnvironmentCacheForTests(): void {
  cachedTerminalShellEnv = undefined
}
