/**
 * Helper for the "Install all" affordance in
 * `PluginPrerequisitesModal`. Opens a fresh terminal tab and writes a
 * sequence of install commands into the spawned PTY so the user
 * watches them run rather than copy-pasting one at a time.
 *
 * Important: this is "watched automation", not silent execution. The
 * user clicked "Install all" → sees a terminal open → sees each
 * command echo and run. Output is fully visible. cc-haha never
 * suppresses or backgrounds anything.
 *
 * Why not pipe everything to a single shell `&&` chain? Two reasons:
 *   1. A failure mid-chain would block remaining commands silently.
 *      Sending each line independently with `\r` lets the user see
 *      every result, fix mid-stream, or copy a different install
 *      method from the modal afterwards.
 *   2. Each command's output stays grouped. Chained commands tend to
 *      collapse output into a hard-to-read wall.
 */

import { terminalApi } from '../api/terminal'
import { useTabStore } from '../stores/tabStore'
import {
  getTerminalRuntime,
  subscribeTerminalRuntime,
  type TerminalRuntime,
} from './terminalRuntime'

const READY_TIMEOUT_MS = 15_000
const PER_COMMAND_DELAY_MS = 150

/**
 * Wait until the terminal runtime has spawned its PTY and is in the
 * `running` state with a valid `nativeSessionId`. Resolves when ready,
 * rejects on timeout. Uses subscribeTerminalRuntime — no busy-wait /
 * polling.
 */
function waitForTerminalReady(runtimeId: string): Promise<TerminalRuntime> {
  return new Promise((resolve, reject) => {
    const runtime = getTerminalRuntime(runtimeId, 'idle')
    if (runtime.status === 'running' && runtime.nativeSessionId != null) {
      resolve(runtime)
      return
    }

    let unsub: (() => void) | null = null
    const timer = setTimeout(() => {
      unsub?.()
      reject(new Error(`Terminal ${runtimeId} did not start within ${READY_TIMEOUT_MS}ms`))
    }, READY_TIMEOUT_MS)

    unsub = subscribeTerminalRuntime(runtime, () => {
      if (runtime.status === 'error' || runtime.status === 'unavailable') {
        clearTimeout(timer)
        unsub?.()
        reject(new Error(`Terminal runtime entered ${runtime.status} state: ${runtime.error ?? ''}`))
        return
      }
      if (runtime.status === 'running' && runtime.nativeSessionId != null) {
        clearTimeout(timer)
        unsub?.()
        resolve(runtime)
      }
    })
  })
}

export type InstallScriptResult = {
  /** The new terminal tab's runtimeId. Caller may use this to focus / cleanup. */
  runtimeId: string
  /** Commands actually written (post-trim, post-empty-skip). */
  commands: string[]
}

/**
 * Open a new terminal tab and inject a sequence of install commands.
 * Each command ends with `\r` so the PTY treats it as user input
 * followed by Enter. Adds a small inter-command delay so output for
 * one command finishes scrolling before the next is echoed —
 * eliminates the "all results pile up at the end" UX.
 *
 * Throws when:
 *   - the host platform doesn't have a terminal capability
 *     (`terminalApi.isAvailable()` is false)
 *   - terminal tab spawn fails or times out
 * Returns the runtime metadata so callers can attach a follow-up
 * UI (e.g. focus the tab, or show a "still running…" indicator).
 */
export async function injectInstallScriptIntoNewTerminal(
  commands: ReadonlyArray<string>,
): Promise<InstallScriptResult> {
  if (!terminalApi.isAvailable()) {
    throw new Error('Terminal not available on this host platform')
  }

  const cleanCommands = commands
    .map((c) => c.trim())
    .filter((c) => c.length > 0)

  if (cleanCommands.length === 0) {
    throw new Error('No commands to inject')
  }

  // Open a brand-new terminal tab. The returned `tabSessionId` is also
  // the runtimeId (since openTerminalTab passes no explicit
  // terminalRuntimeId — see ContentRouter line that picks
  // `tab.terminalRuntimeId ?? tab.sessionId`).
  const tabSessionId = useTabStore.getState().openTerminalTab()

  // Wait for the TerminalSettings host (mounted by ContentRouter) to
  // call terminalApi.spawn() and bind nativeSessionId. Without this
  // wait the very first write would race the spawn.
  const runtime = await waitForTerminalReady(tabSessionId)
  const sessionId = runtime.nativeSessionId
  if (sessionId == null) {
    throw new Error('Terminal nativeSessionId missing after ready')
  }

  // Send each command. `\r` (Carriage Return) is what xterm.js sends
  // for the Enter key; the shell on the other side of the PTY treats
  // it as a complete line and executes. Inter-command delay lets the
  // shell finish printing the prompt before the next command echoes.
  for (let i = 0; i < cleanCommands.length; i++) {
    const cmd = cleanCommands[i]!
    await terminalApi.write(sessionId, cmd + '\r')
    if (i < cleanCommands.length - 1) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, PER_COMMAND_DELAY_MS),
      )
    }
  }

  return { runtimeId: tabSessionId, commands: cleanCommands }
}
