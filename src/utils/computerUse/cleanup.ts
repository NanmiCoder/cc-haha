import type { ToolUseContext } from '../../Tool.js'

import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { withResolvers } from '../withResolvers.js'
import { isLockHeldLocally, releaseComputerUseLock } from './computerUseLock.js'
import { unregisterEscHotkey } from './escHotkey.js'

// cu.apps.unhide is NOT one of the four @MainActor methods wrapped by
// drainRunLoop's 30s backstop. On abort paths (where the user hit Ctrl+C
// because something was slow) a hang here would wedge the abort. Generous
// timeout — unhide should be ~instant; if it takes 5s something is wrong
// and proceeding is better than waiting. The Swift call continues in the
// background regardless; we just stop blocking on it.
const UNHIDE_TIMEOUT_MS = 5000

// The macOS cu-helper daemon's cursor overlay must drop at every turn
// boundary. overlayHide() rides the daemon's 20s REQUEST_TIMEOUT_MS; on an
// abort path a wedged daemon could otherwise stall lock release for that long,
// so we cap the wait here (same non-blocking discipline as UNHIDE_TIMEOUT_MS).
// overlayHide swallows its own rejection, so this race only guards latency.
const OVERLAY_HIDE_TIMEOUT_MS = 2000

/**
 * Turn-end cleanup for the chicago MCP surface: drop the activity indicator
 * (macOS cu-helper overlay, or the Windows virtual cursor), auto-unhide apps
 * that `prepareForAction` hid, then release the file-based lock.
 *
 * Called from three sites: natural turn end (`stopHooks.ts`), abort during
 * streaming (`query.ts` aborted_streaming), abort during tool execution
 * (`query.ts` aborted_tools). All three reach this via dynamic import gated
 * on `feature('CHICAGO_MCP')`. `executor.js` (which pulls both native
 * modules) is dynamic-imported below so non-CU turns don't load native
 * modules just to no-op.
 *
 * No-ops cheaply on non-CU turns: the gate checks are zero-syscall and
 * overlayHide early-returns when nothing was ever shown (Windows, no daemon).
 *
 * NOTE: shutdownDaemon() (INTEGRATION.md §3.4 — kill the warm daemon on session
 * archive/stop) is intentionally NOT done here; per-turn shutdown would defeat
 * the long-lived-daemon optimization. The daemon self-parks on client
 * disconnect and dies with the CLI process; a session-archive hook is a
 * separate follow-up.
 *
 * `deps` is injectable for unit tests only.
 */
export async function cleanupComputerUseAfterTurn(
  ctx: Pick<
    ToolUseContext,
    'getAppState' | 'setAppState' | 'sendOSNotification'
  >,
  deps: {
    overlayHide?: () => Promise<void>
    hideCursorBadge?: () => void
  } = {},
): Promise<void> {
  // Windows counterpart to the macOS overlay. Synchronous, no-throw, and a
  // no-op off-Windows, so it goes first and unconditionally: an orphaned badge
  // would sit on screen claiming the agent is holding the mouse after the turn
  // has ended, which is a worse lie than showing nothing at all.
  const hideBadge =
    deps.hideCursorBadge ??
    (() => {
      void import('./winCursorBadge.js').then(m => m.hideCursorBadge()).catch(() => {})
    })
  hideBadge()

  // Drop the daemon overlay FIRST — before the hidden-apps block and before the
  // isLockHeldLocally early-return below — so the cursor drops promptly even on a
  // turn that hid no apps and whose lock-release short-circuits. overlayHide
  // self-guards on its module-level `overlayShown`, so calling it unconditionally
  // is a single bool check (a pure no-op) off-daemon / on Windows.
  const overlayHide =
    deps.overlayHide ??
    (async () => {
      const m = await import('./cuHelperDaemon.js')
      await m.overlayHide()
    })
  const overlayTimeout = withResolvers<void>()
  const overlayTimer = setTimeout(overlayTimeout.resolve, OVERLAY_HIDE_TIMEOUT_MS)
  await Promise.race([
    overlayHide().catch(() => {}),
    overlayTimeout.promise,
  ]).finally(() => clearTimeout(overlayTimer))

  const appState = ctx.getAppState()

  const hidden = appState.computerUseMcpState?.hiddenDuringTurn
  if (hidden && hidden.size > 0) {
    const { unhideComputerUseApps } = await import('./executor.js')
    const unhide = unhideComputerUseApps([...hidden]).catch(err =>
      logForDebugging(
        `[Computer Use MCP] auto-unhide failed: ${errorMessage(err)}`,
      ),
    )
    const timeout = withResolvers<void>()
    const timer = setTimeout(timeout.resolve, UNHIDE_TIMEOUT_MS)
    await Promise.race([unhide, timeout.promise]).finally(() =>
      clearTimeout(timer),
    )
    ctx.setAppState(prev =>
      prev.computerUseMcpState?.hiddenDuringTurn === undefined
        ? prev
        : {
            ...prev,
            computerUseMcpState: {
              ...prev.computerUseMcpState,
              hiddenDuringTurn: undefined,
            },
          },
    )
  }

  // Zero-syscall pre-check so non-CU turns don't touch disk. Release is still
  // idempotent (returns false if already released or owned by another session).
  if (!isLockHeldLocally()) return

  // Unregister before lock release so the pump-retain drops as soon as the
  // CU session ends. Idempotent — no-ops if registration failed at acquire.
  // Swallow throws so a NAPI unregister error never prevents lock release —
  // a held lock blocks the next CU session with "in use by another session".
  try {
    unregisterEscHotkey()
  } catch (err) {
    logForDebugging(
      `[Computer Use MCP] unregisterEscHotkey failed: ${errorMessage(err)}`,
    )
  }

  if (await releaseComputerUseLock()) {
    ctx.sendOSNotification?.({
      message: 'Claude is done using your computer',
      notificationType: 'computer_use_exit',
    })
  }
}
