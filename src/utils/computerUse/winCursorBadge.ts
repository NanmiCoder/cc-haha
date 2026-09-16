import { spawn, type ChildProcess } from 'node:child_process'
import { logForDebugging } from '../debug.js'
import {
  ensureBootstrapped,
  getComputerUsePythonEnv,
  getCursorBadgeCommand,
} from './pythonBridge.js'

/**
 * Owns the Windows virtual-cursor process for one Computer Use turn.
 *
 * The child installs a low-level mouse hook and must be ready before the first
 * SendInput call. Each action is forwarded over stdin so it can bind the
 * cursor to the destination window instead of following the user's pointer.
 * Rendering remains advisory: startup and IPC failures are logged, swallowed,
 * and never prevent the underlying action.
 */

let badgeProcess: ChildProcess | undefined
let badgeReady: Promise<void> | undefined

type CursorBadgeDependencies = {
  platform: NodeJS.Platform
  bootstrap: () => Promise<void>
  command: () => { python: string; script: string }
  environment: () => NodeJS.ProcessEnv | undefined
  spawnChild: typeof spawn
}

const defaultDependencies: CursorBadgeDependencies = {
  platform: process.platform,
  bootstrap: ensureBootstrapped,
  command: getCursorBadgeCommand,
  environment: getComputerUsePythonEnv,
  spawnChild: spawn,
}

function isRunning(): boolean {
  return badgeProcess !== undefined && badgeProcess.exitCode === null && !badgeProcess.killed
}

function sendActivity(
  child: ChildProcess,
  command: string,
  payload: Record<string, unknown>,
): void {
  try {
    if (!child.stdin?.writable) return
    const targetPid = Number.isSafeInteger(payload.pid) && (payload.pid as number) > 0
      ? payload.pid
      : undefined
    child.stdin.write(`${JSON.stringify({ command, payload, targetPid })}\n`)
  } catch (err) {
    logForDebugging(`virtual cursor activity update failed: ${String(err)}`, { level: 'debug' })
  }
}

/** Start or update the overlay. Idempotent, never throws. */
export async function showCursorBadge(
  command = 'activity',
  payload: Record<string, unknown> = {},
  dependencies: CursorBadgeDependencies = defaultDependencies,
): Promise<void> {
  if (dependencies.platform !== 'win32') return

  if (isRunning()) {
    await badgeReady
    if (badgeProcess) sendActivity(badgeProcess, command, payload)
    return
  }

  try {
    await dependencies.bootstrap()
    const { python, script } = dependencies.command()
    const child = dependencies.spawnChild(python, [script], {
      // stdin carries action updates and its EOF owns the child lifetime.
      // stdout carries the READY handshake; stderr retains diagnostics.
      // Keeping all three pipes is load-bearing — closing stdin is what
      // ties its lifetime to ours even if we are killed rather than exiting.
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false,
      env: dependencies.environment(),
    })

    let resolveReady = () => {}
    const ready = new Promise<void>(resolve => { resolveReady = resolve })
    const readyTimer = setTimeout(resolveReady, 1500)
    badgeReady = ready.finally(() => clearTimeout(readyTimer))

    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.includes('READY\n') || stdout.trim() === 'READY') resolveReady()
    })

    child.on('error', err => {
      logForDebugging(`virtual cursor failed to start: ${String(err)}`, { level: 'debug' })
      resolveReady()
      if (badgeProcess === child) {
        badgeProcess = undefined
        badgeReady = undefined
      }
    })
    child.on('exit', () => {
      resolveReady()
      if (badgeProcess === child) {
        badgeProcess = undefined
        badgeReady = undefined
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      logForDebugging(`virtual cursor: ${chunk.toString().trim()}`, { level: 'debug' })
    })

    badgeProcess = child
    await badgeReady
    if (badgeProcess === child) sendActivity(child, command, payload)
  } catch (err) {
    logForDebugging(`virtual cursor spawn threw: ${String(err)}`, { level: 'debug' })
    badgeProcess = undefined
    badgeReady = undefined
  }
}

/** Take the badge down. Idempotent, never throws. */
export function hideCursorBadge(): void {
  const child = badgeProcess
  badgeProcess = undefined
  badgeReady = undefined
  if (!child) return

  try {
    // Closing stdin is the graceful path — the badge's reader hits EOF and
    // unwinds its own message loop. kill() is the backstop for a process that
    // is wedged before it ever got to that read.
    child.stdin?.end()
    child.kill()
  } catch (err) {
    logForDebugging(`virtual cursor shutdown failed: ${String(err)}`, { level: 'debug' })
  }
}

/** Test hook: forget any tracked process without signalling it. */
export function __resetCursorBadgeState(): void {
  badgeProcess = undefined
  badgeReady = undefined
}

/** Test hook: whether a badge process is currently tracked as running. */
export function __cursorBadgeIsRunning(): boolean {
  return isRunning()
}
