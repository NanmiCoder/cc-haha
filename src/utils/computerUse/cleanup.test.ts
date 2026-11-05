import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import type { ToolUseContext } from '../../Tool.js'
import { getSessionId } from '../../bootstrap/state.js'
import { cleanupComputerUseAfterTurn } from './cleanup.js'
import { checkComputerUseLock, releaseComputerUseLock, tryAcquireComputerUseLock } from './computerUseLock.js'

/**
 * Unit coverage for the turn-end overlay-hide wiring in
 * `cleanupComputerUseAfterTurn`. Driven entirely through the injected
 * `deps.overlayHide` seam — no real cu-helper daemon, no real lock file.
 *
 * The injected-overlay cases leave the file-based lock unacquired, so
 * `isLockHeldLocally()` returns false and the disk release is skipped. With an empty
 * `computerUseMcpState` the hidden-apps/unhide branch is also skipped. So the
 * ONLY observable side effect here is the injected overlayHide — which is
 * exactly what we want to assert on.
 */

type CleanupCtx = Pick<
  ToolUseContext,
  'getAppState' | 'setAppState' | 'sendOSNotification'
>

/** Minimal fake ctx: empty computerUseMcpState → no hidden-apps work. */
function makeCtx(): CleanupCtx {
  // Only the fields cleanup.ts reads matter; the rest of AppState is irrelevant
  // for this path, so we cast a minimal object.
  const appState = { computerUseMcpState: undefined } as unknown as ReturnType<
    ToolUseContext['getAppState']
  >
  return {
    getAppState: () => appState,
    setAppState: () => {},
    sendOSNotification: () => {},
  }
}

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

test('a stale finalizer leaves the replacement turn’s overlay and lock alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-haha-computer-use-turn-'))
  const previousConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  const first = Symbol()
  const replacement = Symbol()
  try {
    expect(await tryAcquireComputerUseLock(first)).toEqual({ kind: 'acquired', fresh: true })
    // Same-session work can still share the lock without changing its owner.
    expect(await tryAcquireComputerUseLock(replacement)).toEqual({ kind: 'acquired', fresh: false })
    expect(await Promise.all([
      releaseComputerUseLock(first),
      releaseComputerUseLock(first),
    ])).toEqual([true, false])
    expect(await tryAcquireComputerUseLock(replacement)).toEqual({ kind: 'acquired', fresh: true })

    let hides = 0
    const overlayHide = async () => { hides++ }
    const hideCursorBadge = () => {}
    await cleanupComputerUseAfterTurn(makeCtx(), { overlayHide, hideCursorBadge, ownedTurn: first })
    expect(await releaseComputerUseLock(first)).toBe(false)
    expect(hides).toBe(0)
    expect(await checkComputerUseLock()).toEqual({ kind: 'held_by_self' })
    await cleanupComputerUseAfterTurn(makeCtx(), { overlayHide, hideCursorBadge, ownedTurn: replacement })
    expect(hides).toBe(1)
    expect(await checkComputerUseLock()).toEqual({ kind: 'free' })
  } finally {
    await releaseComputerUseLock()
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfig
    await rm(root, { recursive: true, force: true })
  }
})

test('a resumed session recovers a lock after its previous process exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-haha-computer-use-resume-'))
  const previousConfig = process.env.CLAUDE_CONFIG_DIR
  const predecessor = Bun.spawn([process.execPath, '--no-env-file', '-e', 'setInterval(() => {}, 1000)'], {
    cwd: root,
    env: createSandboxedTestEnvironment(root),
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
  })
  const path = join(root, 'computer-use.lock')
  const sessionId = getSessionId()
  const turn = Symbol()
  process.env.CLAUDE_CONFIG_DIR = root
  try {
    await writeFile(path, JSON.stringify({ sessionId, pid: predecessor.pid, acquiredAt: Date.now() }))
    expect(await checkComputerUseLock()).toEqual({ kind: 'blocked', by: sessionId })
    expect(await tryAcquireComputerUseLock(turn)).toEqual({ kind: 'blocked', by: sessionId })

    predecessor.kill()
    await predecessor.exited
    expect(await tryAcquireComputerUseLock(turn)).toEqual({ kind: 'acquired', fresh: true })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ sessionId, pid: process.pid })
    expect(await releaseComputerUseLock(turn)).toBe(true)
  } finally {
    if (predecessor.exitCode === null) predecessor.kill()
    await predecessor.exited
    await releaseComputerUseLock(turn)
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfig
    await rm(root, { recursive: true, force: true })
  }
})

describe('cleanupComputerUseAfterTurn — turn-end overlay hide', () => {
  test('calls the injected overlayHide exactly once on a no-hidden-apps, lock-not-held turn', async () => {
    // Proves overlayHide runs even when the turn hid nothing AND the lock-release
    // path early-returns (isLockHeldLocally() is false in this process) — i.e. it
    // runs BEFORE that early return, so the cursor never gets stuck.
    let hidden = 0
    await cleanupComputerUseAfterTurn(makeCtx(), {
      overlayHide: async () => {
        hidden++
      },
    })
    expect(hidden).toBe(1)
  })

  test('a REJECTING overlayHide does not throw and cleanup still completes', async () => {
    let hidden = 0
    // Must resolve, not reject — overlayHide failures are best-effort.
    await cleanupComputerUseAfterTurn(makeCtx(), {
      overlayHide: async () => {
        hidden++
        throw new Error('daemon overlay_hide blew up')
      },
    })
    expect(hidden).toBe(1)
  })

  test('a HANGING overlayHide is capped by the timeout and does not wedge cleanup', async () => {
    // The daemon call rides a 20s request timeout; the abort paths cannot wait
    // that long. cleanup wraps overlayHide in a ~2s Promise.race, so a hung
    // overlayHide must still let cleanup resolve. We prove the race timeout is
    // load-bearing: cleanup is still pending shortly after the call (so it did
    // NOT skip overlayHide), then resolves via the timeout even though the
    // injected overlayHide never settles.
    let resolved = false
    const p = cleanupComputerUseAfterTurn(makeCtx(), {
      // Never resolves — if cleanup awaited it unguarded, this would hang.
      overlayHide: () => new Promise<void>(() => {}),
    }).then(() => {
      resolved = true
    })

    // Before the ~2s race timeout fires, cleanup is still pending.
    await delay(50)
    expect(resolved).toBe(false)

    // It must eventually resolve via the timeout path (well within the 20s
    // daemon timeout). Wait it out.
    await p
    expect(resolved).toBe(true)
  }, 10_000)

  test('overlayHide is invoked on the abort-style ctx too (same ctx shape)', async () => {
    // The 3 production call sites (natural end + 2 abort paths) all pass the same
    // ToolUseContext shape; this is the abort case exercising the same code.
    let hidden = 0
    await cleanupComputerUseAfterTurn(makeCtx(), {
      overlayHide: async () => {
        hidden++
      },
    })
    expect(hidden).toBe(1)
  })
})

describe('cleanupComputerUseAfterTurn — turn-end cursor badge', () => {
  test('drops the Windows badge on a turn that hid nothing', async () => {
    // The badge is a standing claim that the agent is holding the mouse. If it
    // outlives the turn it is simply false, and the user has no way to tell
    // that from a turn still in progress.
    let hidden = 0
    await cleanupComputerUseAfterTurn(makeCtx(), {
      overlayHide: async () => {},
      hideCursorBadge: () => { hidden += 1 },
    })
    expect(hidden).toBe(1)
  })

  test('drops the badge even when overlayHide hangs past its timeout', async () => {
    // Abort paths are exactly when a stuck indicator is most likely and most
    // confusing. The badge teardown must not sit behind the daemon's.
    let hidden = 0
    await cleanupComputerUseAfterTurn(makeCtx(), {
      overlayHide: () => new Promise<void>(() => {}),
      hideCursorBadge: () => { hidden += 1 },
    })
    expect(hidden).toBe(1)
  })

  test('drops the badge even when overlayHide rejects', async () => {
    let hidden = 0
    await cleanupComputerUseAfterTurn(makeCtx(), {
      overlayHide: async () => { throw new Error('daemon gone') },
      hideCursorBadge: () => { hidden += 1 },
    })
    expect(hidden).toBe(1)
  })
})
