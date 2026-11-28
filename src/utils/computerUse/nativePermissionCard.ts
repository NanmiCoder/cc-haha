import { spawn } from 'node:child_process'
import { logForDebugging } from '../debug.js'
import { resolveLaunchableCuHelperBinaryAsync } from './cuHelperBridge.js'

/**
 * Auto-present the native macOS permission card (`cu-helper request-access`)
 * when Computer Use is missing a TCC grant — so the user grants Accessibility /
 * Screen Recording through a guided card (open-the-right-pane + drag + live
 * status), never a shell command.
 *
 * Responsible-process note: this is spawned from the same CLI process that runs
 * the executor, so the card grants the SAME `cu-helper` binary that actually
 * performs injection/capture → the card's ✅ means Computer Use will really work.
 *
 * Fire-and-forget. Debounced (one card at a time) + cooled-down (don't re-pop
 * the instant the user dismisses it). No-op off macOS or when the binary isn't
 * built. Never throws — failures are logged and swallowed.
 */

export type OsPermissions = {
  accessibility: boolean
  screenRecording: boolean | null
}

const COOLDOWN_MS = 15_000

let cardInFlight = false
// -Infinity (not 0) so the FIRST call is never mistaken for "shown recently"
// regardless of the clock's magnitude.
let lastShownAt = Number.NEGATIVE_INFINITY

type SpawnFn = typeof spawn

export function maybeShowNativePermissionCard(
  perms?: OsPermissions,
  deps: {
    platform?: NodeJS.Platform
    resolveBin?: () => string | null | Promise<string | null>
    spawnFn?: SpawnFn
    now?: () => number
  } = {},
): void {
  const platform = deps.platform ?? process.platform
  if (platform !== 'darwin') return

  const now = (deps.now ?? Date.now)()
  if (cardInFlight) return
  if (now - lastShownAt < COOLDOWN_MS) return

  const doSpawn = deps.spawnFn ?? spawn
  const launch = (bin: string | null) => {
    if (!bin) {
      cardInFlight = false
      return
    }
    cardInFlight = true
    lastShownAt = now
    try {
      const child = doSpawn(bin, ['request-access'], {
        stdio: 'ignore',
        detached: false,
      })
      child.on('exit', () => {
        cardInFlight = false
      })
      child.on('error', (err: unknown) => {
        cardInFlight = false
        logForDebugging(`cu-helper request-access failed to launch: ${String(err)}`, {
          level: 'warn',
        })
      })
      // Don't let the card window keep the CLI's event loop alive.
      child.unref?.()
      if (perms) {
        logForDebugging(
          `shown native permission card (accessibility=${perms.accessibility}, screenRecording=${perms.screenRecording})`,
          { level: 'debug' },
        )
      }
    } catch (err) {
      cardInFlight = false
      logForDebugging(`cu-helper request-access spawn threw: ${String(err)}`, {
        level: 'warn',
      })
    }
  }

  // Launch the card from the STANDALONE-INSTALLED helper so its drag subject
  // (Bundle.main.bundleURL) is the same standalone `.app` the daemon runs from —
  // dragging THAT into Screen Recording grants the helper's own SR subject, and
  // dragging it into Accessibility grants the helper too. One identity, both
  // permissions. (See cuHelperInstall.ts.)
  const resolved = (deps.resolveBin ?? resolveLaunchableCuHelperBinaryAsync)()
  if (resolved && typeof (resolved as Promise<string | null>).then === 'function') {
    cardInFlight = true
    void (resolved as Promise<string | null>).then(
      (bin) => launch(bin),
      () => { cardInFlight = false },
    )
    return
  }
  launch(resolved as string | null)
}

/** Test hook: reset debounce / cooldown state. */
export function __resetNativeCardState(): void {
  cardInFlight = false
  lastShownAt = Number.NEGATIVE_INFINITY
}
