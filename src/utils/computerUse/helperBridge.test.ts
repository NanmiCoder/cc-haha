import { afterEach, describe, expect, test } from 'bun:test'
import { __resetHelperBridgeState, callHelper } from './helperBridge.js'
import {
  DaemonCommandResultUnknownError,
  DaemonCommandTimeoutError,
  DaemonUnavailableError,
} from './cuHelperDaemon.js'

afterEach(() => __resetHelperBridgeState())

const ok = async <R>() => 0 as unknown as R

describe('callHelper platform routing', () => {
  test('macOS + available → DAEMON (the animated-overlay engine)', async () => {
    let used = ''
    const r = await callHelper<string>('list_displays', {}, {
      platform: 'darwin',
      cuHelperAvailable: () => true,
      callDaemon: async () => { used = 'daemon'; return 'D' as never },
      callPy: async () => { used = 'py'; return 'P' as never },
      overlayShow: () => {},
    })
    expect(used).toBe('daemon')
    expect(r).toBe('D')
  })

  test('FIRST injection passes the explicit target to overlay_show', async () => {
    const shown: Record<string, unknown>[] = []
    await callHelper('click', { pid: 4321, x: 1, y: 2 }, {
      platform: 'darwin',
      cuHelperAvailable: () => true,
      callDaemon: ok,
      isOverlayShown: () => false,
      overlayShow: payload => { shown.push(payload) },
    })
    expect(shown).toEqual([{ pid: 4321 }])
  })

  test('select_text initiates overlay feedback without blocking daemon dispatch', async () => {
    const events: string[] = []
    await callHelper('select_text', { element_index: 'g1:2', text: 'hello' }, {
      platform: 'darwin',
      cuHelperAvailable: () => true,
      callDaemon: async () => { events.push('dispatch'); return true as never },
      isOverlayShown: () => false,
      overlayShow: () => { events.push('overlay') },
    })

    expect(events).toEqual(['overlay', 'dispatch'])
  })

  test('SECOND injection for the SAME explicit target does NOT re-show', async () => {
    const shown: Record<string, unknown>[] = []
    await callHelper('type_text', { pid: 4321, text: 'x' }, {
      platform: 'darwin',
      cuHelperAvailable: () => true,
      callDaemon: ok,
      isOverlayShown: () => false,
      overlayShow: payload => { shown.push(payload) },
    })
    await callHelper('type', { pid: 4321, text: 'hi' }, {
      platform: 'darwin',
      cuHelperAvailable: () => true,
      callDaemon: ok,
      isOverlayShown: () => true,
      overlayShow: payload => { shown.push(payload) },
    })
    expect(shown).toEqual([{ pid: 4321 }])
  })

  test('injection for a different explicit target re-shows without consulting frontmost', async () => {
    const shown: Record<string, unknown>[] = []
    let frontmostProbes = 0
    await callHelper('click', { app: 'Safari' }, {
      platform: 'darwin',
      cuHelperAvailable: () => true,
      callDaemon: ok,
      isOverlayShown: () => false,
      overlayShow: payload => { shown.push(payload) },
      callFrontmost: async () => { frontmostProbes++; return { bundleId: 'dev.cchaha.host' } },
    })
    await callHelper('click', { bundleId: 'com.apple.Notes' }, {
      platform: 'darwin',
      cuHelperAvailable: () => true,
      callDaemon: ok,
      isOverlayShown: () => true,
      overlayShow: payload => { shown.push(payload) },
      callFrontmost: async () => { frontmostProbes++; return { bundleId: 'dev.cchaha.host' } },
    })
    expect(shown).toEqual([
      { app: 'Safari' },
      { bundleId: 'com.apple.Notes' },
    ])
    expect(frontmostProbes).toBe(0)
  })

  test('read-only command does NOT show the overlay', async () => {
    let shown = 0
    await callHelper('screenshot', {}, {
      platform: 'darwin',
      cuHelperAvailable: () => true,
      callDaemon: ok,
      isOverlayShown: () => false,
      overlayShow: () => { shown++ },
      callFrontmost: async () => ({ bundleId: 'com.apple.Safari' }),
    })
    expect(shown).toBe(0)
  })

  test('overlay show never blocks the injection dispatch', async () => {
    let dispatched = false
    const r = await callHelper<string>('click', {}, {
      platform: 'darwin',
      cuHelperAvailable: () => true,
      callDaemon: async () => { dispatched = true; return 'D' as never },
      isOverlayShown: () => false,
      overlayShow: () => {},
    })
    expect(dispatched).toBe(true)
    expect(r).toBe('D')
  })

  test('callers cannot disable the authenticated daemon path', async () => {
    let shown = 0
    const calls: string[] = []
    await callHelper('type_text', { text: 'x' }, {
      platform: 'darwin',
      cuHelperAvailable: () => true,
      callDaemon: async () => { calls.push('daemon'); return true as never },
      isOverlayShown: () => true,
      overlayShow: () => { shown++ },
    })
    expect(shown).toBe(1)
    expect(calls).toEqual(['daemon'])
  })

  test('daemon INFRA failure fails closed without a one-shot CLI fallback', async () => {
    const calls: string[] = []
    await expect(callHelper<string>('type_text', { text: 'hello' }, {
        platform: 'darwin',
        cuHelperAvailable: () => true,
        callDaemon: async () => { calls.push('daemon'); throw new DaemonUnavailableError('no daemon') },
        callPy: async () => { calls.push('python'); return 'P' as never },
        overlayShow: () => {},
      })).rejects.toThrow(/native_daemon_required: type_text/)
    expect(calls).toEqual(['daemon'])
  })

  test('daemon INFRA failure never consults the stateless native CLI', async () => {
    const calls: string[] = []
    await expect(
      callHelper('press_key', { key: 'super+c', systemKeyCombos: false }, {
        platform: 'darwin',
        cuHelperAvailable: () => true,
        callDaemon: async () => { calls.push('daemon'); throw new DaemonUnavailableError('no daemon') },
        callPy: async () => { calls.push('python'); return 0 as never },
        overlayShow: () => {},
        callFrontmost: async () => null,
      }),
    ).rejects.toThrow(/native_daemon_required: press_key/)
    expect(calls).toEqual(['daemon'])
  })

  test('stateful semantic commands fail closed when the persistent daemon is unavailable', async () => {
    const stateful: Array<[string, Record<string, unknown>]> = [
      ['get_app_state', { app: 'Finder' }],
      ['click', { app: 'Finder', x: 1, y: 2 }],
      ['set_value', { app: 'TextEdit', index: 'g1:2', value: 'x' }],
      ['select_text', { app: 'TextEdit', index: 'g1:2', text: 'x' }],
      ['perform_secondary_action', { app: 'Finder', index: 'g1:2', action: 'Raise' }],
      ['scroll', { app: 'Finder', direction: 'down', pages: 1 }],
      ['drag', { from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }],
    ]

    for (const [command, payload] of stateful) {
      __resetHelperBridgeState()
      const calls: string[] = []
      await expect(
        callHelper(command, payload, {
          platform: 'darwin',
          cuHelperAvailable: () => true,
          callDaemon: async () => {
            calls.push('daemon')
            throw new DaemonUnavailableError('failed before dispatch')
          },
          callPy: async () => { calls.push('python'); return 0 as never },
          overlayShow: () => {},
          callFrontmost: async () => null,
        }),
      ).rejects.toThrow(new RegExp(`native_daemon_required: ${command}`))
      expect(calls).toEqual(['daemon'])
    }
  })

  test('a daemon infrastructure failure does not create a CLI fallback latch', async () => {
    const calls: string[] = []
    const deps = {
      platform: 'darwin' as const,
      cuHelperAvailable: () => true,
      callDaemon: async () => {
        calls.push('daemon')
        throw new DaemonUnavailableError('failed before dispatch')
      },
      callPy: async () => { calls.push('python'); return 'PY' as never },
      overlayShow: () => {},
      callFrontmost: async () => null,
    }

    await expect(callHelper('type_text', { text: 'safe' }, deps))
      .rejects.toThrow(/native_daemon_required: type_text/)
    await expect(callHelper('get_app_state', { app: 'Finder' }, deps))
      .rejects.toThrow(/native_daemon_required: get_app_state/)
    expect(calls).toEqual(['daemon', 'daemon'])
  })

  test('post-dispatch daemon timeout fails closed without replaying the mutation', async () => {
    const calls: string[] = []
    await expect(
      callHelper('click', { x: 1, y: 2 }, {
        platform: 'darwin',
        cuHelperAvailable: () => true,
        callDaemon: async () => {
          calls.push('daemon')
          throw new DaemonCommandTimeoutError(
            'cu-helper daemon command click timed out; execution result is unknown',
          )
        },
        callPy: async () => { calls.push('python'); return 0 as never },
        overlayShow: () => {},
        callFrontmost: async () => null,
      }),
    ).rejects.toThrow(/execution result is unknown/)
    expect(calls).toEqual(['daemon'])
  })

  test('post-dispatch socket loss fails closed without CLI or Python replay', async () => {
    const calls: string[] = []
    await expect(
      callHelper('type_text', { text: 'once' }, {
        platform: 'darwin',
        cuHelperAvailable: () => true,
        callDaemon: async () => {
          calls.push('daemon')
          throw new DaemonCommandResultUnknownError(
            'cu-helper daemon socket closed; execution result is unknown',
          )
        },
        callPy: async () => { calls.push('python'); return 0 as never },
        overlayShow: () => {},
        callFrontmost: async () => null,
      }),
    ).rejects.toThrow(/execution result is unknown/)
    expect(calls).toEqual(['daemon'])
  })

  test('daemon COMMAND error (not_trusted) propagates — no CLI fallback, restart once', async () => {
    // A plain Error from the daemon is a command-level failure (the daemon ran
    // the command and rejected it). The bridge must NOT silently retry on the
    // CLI (which fails the same way, minus the overlay); it must surface the
    // error. On not_trusted it also restarts the daemon ONCE so a post-grant
    // retry reads the live Accessibility grant.
    const calls: string[] = []
    let restarts = 0
    await expect(
      callHelper<string>('click', { x: 1, y: 2 }, {
        platform: 'darwin',
        cuHelperAvailable: () => true,
        callDaemon: async () => { calls.push('daemon'); throw new Error('not_trusted: Accessibility permission is required') },
        callPy: async () => { calls.push('python'); return 'P' as never },
        overlayShow: () => {},
        callFrontmost: async () => null,
        shutdownDaemon: () => { restarts++ },
      }),
    ).rejects.toThrow(/not_trusted/)
    expect(calls).toEqual(['daemon']) // never touched the CLI
    expect(restarts).toBe(1) // restarted exactly once
  })

  test('not_trusted restart is one-shot until a daemon command succeeds again', async () => {
    let restarts = 0
    const deps = (fail: boolean) => ({
      platform: 'darwin' as const,
      cuHelperAvailable: () => true,
      callDaemon: async () => {
        if (fail) throw new Error('not_trusted')
        return 'OK' as never
      },
      overlayShow: () => {},
      callFrontmost: async () => null,
      shutdownDaemon: () => { restarts++ },
    })
    // First not_trusted → restart #1.
    await expect(callHelper('click', {}, deps(true))).rejects.toThrow(/not_trusted/)
    // Second not_trusted (still ungranted) → NO extra restart (latched).
    await expect(callHelper('click', {}, deps(true))).rejects.toThrow(/not_trusted/)
    expect(restarts).toBe(1)
    // A success re-arms the latch…
    await callHelper('click', {}, deps(false))
    // …so the next ungranted streak can restart once more.
    await expect(callHelper('click', {}, deps(true))).rejects.toThrow(/not_trusted/)
    expect(restarts).toBe(2)
  })

  test('later calls retry the authenticated daemon instead of latching to CLI', async () => {
    const calls: string[] = []
    const deps = {
      platform: 'darwin' as const,
      cuHelperAvailable: () => true,
      callDaemon: async () => { calls.push('daemon'); throw new DaemonUnavailableError('no daemon') },
      callPy: async () => { calls.push('python'); return 'P' as never },
      overlayShow: () => {},
      callFrontmost: async () => null,
    }

    await expect(callHelper('type_text', { text: 'a' }, deps))
      .rejects.toThrow(/native_daemon_required/)
    await expect(callHelper('type_text', { text: 'b' }, deps))
      .rejects.toThrow(/native_daemon_required/)
    expect(calls).toEqual(['daemon', 'daemon'])
  })

  test('all macOS commands dispatch through the daemon', async () => {
    const calls: string[] = []
    for (const command of ['type_text', 'press_key', 'click']) {
      await callHelper(command, {}, {
        platform: 'darwin',
        cuHelperAvailable: () => true,
        callDaemon: async () => { calls.push('daemon'); return 0 as never },
        callPy: async () => { calls.push('python'); return 0 as never },
        overlayShow: () => {},
      })
    }
    expect(calls).toEqual(['daemon', 'daemon', 'daemon'])
  })

  test('macOS without cu-helper fails closed and never calls Python', async () => {
    const calls: string[] = []
    await expect(
      callHelper('cmd', {}, {
        platform: 'darwin',
        cuHelperAvailable: () => false,
        callDaemon: async () => { calls.push('daemon'); return 0 as never },
        callPy: async () => { calls.push('python'); return 0 as never },
        overlayShow: () => {},
      }),
    ).rejects.toThrow(/native_helper_unavailable/)
    expect(calls).toEqual([])
  })

  test('Windows always uses the Python helper', async () => {
    let used = ''
    await callHelper('cmd', {}, {
      platform: 'win32',
      cuHelperAvailable: () => true,
      callDaemon: async () => { used = 'daemon'; return 0 as never },
      callPy: async () => { used = 'py'; return 0 as never },
      overlayShow: () => {},
      showCursorBadge: () => {},
    })
    expect(used).toBe('py')
  })

  test('Windows prepares the virtual cursor before dispatching an injecting command', async () => {
    const events: string[] = []
    let shownCommand = ''
    let shownPayload: Record<string, unknown> = {}
    await callHelper('click', { x: 1, y: 2 }, {
      platform: 'win32',
      callPy: async () => { events.push('action'); return true as never },
      showCursorBadge: async (command, payload) => {
        events.push('overlay:start')
        shownCommand = command
        shownPayload = payload
        await Promise.resolve()
        events.push('overlay:ready')
      },
    })
    expect(events).toEqual(['overlay:start', 'overlay:ready', 'action'])
    expect(shownCommand).toBe('click')
    expect(shownPayload).toEqual({ x: 1, y: 2 })
  })

  test('Windows leaves the badge alone for read-only commands', async () => {
    // A badge on `screenshot` would claim the agent is holding the mouse
    // during a turn that never touches it.
    let badges = 0
    for (const command of ['screenshot', 'list_displays', 'read_clipboard']) {
      await callHelper(command, {}, {
        platform: 'win32',
        callPy: ok,
        showCursorBadge: () => { badges += 1 },
      })
    }
    expect(badges).toBe(0)
  })

  test('Windows never reaches the macOS overlay', async () => {
    // The two indicators are not interchangeable: overlay_show is a daemon
    // command and there is no daemon on Windows, so a stray call would be a
    // hard failure on the mutation path.
    let overlays = 0
    await callHelper('click', { x: 1, y: 2 }, {
      platform: 'win32',
      callPy: ok,
      overlayShow: () => { overlays += 1 },
      showCursorBadge: () => {},
    })
    expect(overlays).toBe(0)
  })

  test('macOS never spawns the Windows badge', async () => {
    let badges = 0
    await callHelper('click', { x: 1, y: 2 }, {
      platform: 'darwin',
      cuHelperAvailable: () => true,
      callDaemon: ok,
      overlayShow: () => {},
      showCursorBadge: () => { badges += 1 },
    })
    expect(badges).toBe(0)
  })

  test('forwards command + payload to the daemon unchanged', async () => {
    let seen: { c: string; p: unknown } | undefined
    await callHelper('type', { text: 'hi' }, {
      platform: 'darwin',
      cuHelperAvailable: () => true,
      callDaemon: async (c, p) => { seen = { c, p }; return 0 as never },
      overlayShow: () => {},
      callFrontmost: async () => null,
    })
    expect(seen).toEqual({ c: 'type', p: { text: 'hi' } })
  })
})
