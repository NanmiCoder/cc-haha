import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { getCwd } from '../../utils/cwd.js'
import { getMcpStdioEnvironment } from '../../utils/mcpStdioEnvironment.js'

type HostCommandCheckResult =
  | {
      ok: true
      resolvedCommand: string
    }
  | {
      ok: false
      message: string
    }

function getPathSearchList(envPath?: string) {
  return (envPath ?? process.env.PATH ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function getWindowsExecutableCandidates(command: string) {
  if (process.platform !== 'win32') {
    return [command]
  }

  const ext = path.extname(command)
  if (ext) {
    return [command]
  }

  const pathext = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)

  return [command, ...pathext.map((entry) => `${command}${entry.toLowerCase()}`)]
}

function isPathLikeCommand(command: string) {
  return (
    path.isAbsolute(command) ||
    command.startsWith('./') ||
    command.startsWith('../') ||
    command.startsWith('.\\') ||
    command.startsWith('..\\') ||
    command.includes('/') ||
    command.includes('\\')
  )
}

function buildRuntimeHint(command: string) {
  const normalized = path.basename(command).toLowerCase()

  if (['node', 'npm', 'npx', 'pnpm', 'yarn'].includes(normalized)) {
    return `Install Node.js on this machine so "${command}" is available in PATH, then retry.`
  }

  if (['python', 'python3', 'pip', 'pip3'].includes(normalized)) {
    return `Install Python on this machine so "${command}" is available in PATH, then retry.`
  }

  if (normalized === 'uv') {
    return 'Install uv on this machine so "uv" is available in PATH, then retry.'
  }

  if (normalized === 'bun') {
    return 'Install Bun on this machine so "bun" is available in PATH, then retry.'
  }

  return `Install "${command}" on this machine or update PATH, then retry.`
}

function buildMissingCommandMessage(command: string) {
  return `Host command "${command}" is not available in PATH. This STDIO MCP runs on the host machine. ${buildRuntimeHint(command)}`
}

function buildMissingPathMessage(command: string, resolvedPath: string) {
  return `Host command path "${command}" could not be found at "${resolvedPath}". This STDIO MCP runs on the host machine, so the configured executable path must exist locally.`
}

function buildNonExecutablePathMessage(command: string, resolvedPath: string) {
  return `Host command path "${command}" exists at "${resolvedPath}" but is not executable. This STDIO MCP runs on the host machine, so the configured executable must be runnable by the local OS user.`
}

async function resolveCommandFromPath(
  command: string,
  envPath?: string,
  cwd: string = getCwd(),
): Promise<string | null> {
  const pathEntries = getPathSearchList(envPath)

  for (const entry of pathEntries) {
    for (const candidate of getWindowsExecutableCandidates(command)) {
      const resolvedPath = path.resolve(cwd, entry, candidate)
      try {
        await access(
          resolvedPath,
          process.platform === 'win32' ? constants.F_OK : constants.X_OK,
        )
        return resolvedPath
      } catch {
        // Continue searching other PATH entries.
      }
    }
  }

  return null
}

export async function inspectMcpHostCommand(
  command: string,
  cwd: string = getCwd(),
  env?: Record<string, string>,
): Promise<HostCommandCheckResult> {
  const trimmedCommand = command.trim()
  if (!trimmedCommand) {
    return {
      ok: false,
      message: 'STDIO MCP command is empty.',
    }
  }

  if (isPathLikeCommand(trimmedCommand)) {
    const resolvedPath = path.isAbsolute(trimmedCommand)
      ? trimmedCommand
      : path.resolve(cwd, trimmedCommand)

    try {
      await access(
        resolvedPath,
        process.platform === 'win32' ? constants.F_OK : constants.X_OK,
      )
      return {
        ok: true,
        resolvedCommand: resolvedPath,
      }
    } catch (error) {
      const maybeErr = error as NodeJS.ErrnoException
      return {
        ok: false,
        message:
          maybeErr.code === 'ENOENT'
            ? buildMissingPathMessage(trimmedCommand, resolvedPath)
            : buildNonExecutablePathMessage(trimmedCommand, resolvedPath),
      }
    }
  }

  const hasExplicitPath = env ? Object.hasOwn(env, 'PATH') : false
  const resolvedCommand = hasExplicitPath
    ? await resolveCommandFromPath(trimmedCommand, env?.PATH, cwd)
    : await resolveCommandFromPath(trimmedCommand, process.env.PATH, cwd)
  if (resolvedCommand) {
    return {
      ok: true,
      resolvedCommand,
    }
  }

  if (!hasExplicitPath) {
    const stdioEnv = await getMcpStdioEnvironment(env)
    const shellResolvedCommand = await resolveCommandFromPath(
      trimmedCommand,
      stdioEnv.PATH,
      cwd,
    )
    if (shellResolvedCommand) {
      return {
        ok: true,
        resolvedCommand: shellResolvedCommand,
      }
    }
  }

  return {
    ok: false,
    message: buildMissingCommandMessage(trimmedCommand),
  }
}
