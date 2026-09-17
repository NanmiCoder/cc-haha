import { describe, expect, test } from 'bun:test'
import {
  assertChangedState,
  assertCleanupEvidence,
  assertMonitorContinuity,
  assertPointerTrace,
  assertNoChangeState,
  assertSafeRunDirectory,
  assertScreenshotChanged,
  assertStaleHandleFailure,
  assertSystemStatePreserved,
  acquireLiveSmokeLock,
  deriveLiveSmokePaths,
  findEditableHandle,
  hasExactNoChangeState,
  hasFreshScreenshot,
  errorMessage,
  parseInputMonitorSnapshot,
  parseLiveSmokeArgs,
  parseSystemSnapshot,
  type LiveAppState,
  type SystemSnapshot,
} from './computer-use-live-smoke.js'

const initialSystemSnapshot: SystemSnapshot = {
  frontmost: {
    pid: 101,
    bundleId: 'com.openai.codex',
    executablePath: '/Applications/Codex.app/Contents/MacOS/Codex',
    launchTime: 1234.5,
  },
  pointer: { x: 100, y: 200 },
  input: {
    flags: '0',
    buttons: [false, false, false, false, false],
  },
}

const PNG_ONE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const PNG_TWO =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

function state(overrides: Partial<LiveAppState> = {}): LiveAppState {
  return {
    pid: 220,
    bundleId: 'com.apple.TextEdit',
    appName: 'TextEdit',
    windowTitle: 'smoke-fixture.txt',
    elementCount: 3,
    truncated: false,
    durationMs: 10,
    axText: [
      'g8:0 standard window smoke-fixture.txt',
      '\tg8:7 text area CC_HAHA_SMOKE_STABLE_TOKEN',
      '\tg8:9 button close',
    ].join('\n'),
    elements: [
      {
        index: 7,
        role: 'AXTextArea',
        settable: true,
        value: 'CC_HAHA_SMOKE_STABLE_TOKEN',
      },
    ],
    screenshot: {
      base64: PNG_ONE,
      width: 1,
      height: 1,
    },
    ...overrides,
  }
}

describe('computer-use live smoke CLI safety', () => {
  test('surfaces every primary and cleanup error from an AggregateError', () => {
    expect(errorMessage(new AggregateError([
      new Error('primary failed'),
      new Error('cleanup failed'),
    ], 'smoke failed'))).toContain('primary failed')
    expect(errorMessage(new AggregateError([
      new Error('primary failed'),
      new Error('cleanup failed'),
    ], 'smoke failed'))).toContain('cleanup failed')
  })

  test('defaults to the dedicated TextEdit target and accepts only its exact bundle id', () => {
    expect(parseLiveSmokeArgs([])).toEqual({
      targetBundleId: 'com.apple.TextEdit',
    })
    expect(parseLiveSmokeArgs(['--target', 'com.apple.TextEdit'])).toEqual({
      targetBundleId: 'com.apple.TextEdit',
    })
  })

  test('acquires/releases the production lock and performs no release when blocked', async () => {
    let releases = 0
    const release = await acquireLiveSmokeLock(
      async () => ({ kind: 'acquired', fresh: true }),
      async () => {
        releases += 1
        return true
      },
    )
    expect(releases).toBe(0)
    await release()
    expect(releases).toBe(1)

    let blockedRelease = 0
    await expect(
      acquireLiveSmokeLock(
        async () => ({ kind: 'blocked', by: 'other-session' }),
        async () => {
          blockedRelease += 1
          return true
        },
      ),
    ).rejects.toThrow(/did not start/i)
    expect(blockedRelease).toBe(0)
  })

  test('refuses Finder, terminal, system, and arbitrary targets', () => {
    for (const target of [
      'Finder',
      'com.apple.finder',
      'Terminal',
      'com.apple.Terminal',
      'System Settings',
      'com.apple.systempreferences',
      'com.googlecode.iterm2',
      'com.example.OtherApp',
    ]) {
      expect(() => parseLiveSmokeArgs(['--target', target])).toThrow(
        /dedicated TextEdit/i,
      )
    }
  })

  test('rejects missing values and unknown CLI flags', () => {
    expect(() => parseLiveSmokeArgs(['--target'])).toThrow(/value/i)
    expect(() => parseLiveSmokeArgs(['--fixture', '/tmp/user-file.txt'])).toThrow(
      /unknown argument/i,
    )
  })
})

describe('computer-use live smoke path confinement', () => {
  test.skipIf(process.platform === 'win32')('derives the fixture and this process daemon artifacts deterministically', () => {
    expect(
      deriveLiveSmokePaths(
        '/tmp/cc-haha-cu-live-smoke-ABC123',
        '/Users/test/.claude/.runtime',
        4321,
      ),
    ).toEqual({
      runDirectory: '/tmp/cc-haha-cu-live-smoke-ABC123',
      fixturePath:
        '/tmp/cc-haha-cu-live-smoke-ABC123/computer-use-smoke-fixture.txt',
      targetIdentityPath:
        '/tmp/cc-haha-cu-live-smoke-ABC123/.textedit-identity.json',
      daemonSocket:
        '/Users/test/.claude/.runtime/cu-helper.daemon.4321.1.sock',
      daemonPidfile:
        '/Users/test/.claude/.runtime/cu-helper.daemon.4321.1.sock.pid',
    })
  })

  test.skipIf(process.platform === 'win32')('accepts only one generated child directory directly beneath /tmp', () => {
    expect(() =>
      assertSafeRunDirectory('/tmp/cc-haha-cu-live-smoke-ABC123'),
    ).not.toThrow()

    for (const unsafe of [
      '/',
      '/tmp',
      '/tmp/cc-haha-cu-live-smoke-',
      '/tmp/cc-haha-cu-live-smoke-ABC123/..',
      '/var/tmp/cc-haha-cu-live-smoke-ABC123',
      '/tmp/other-ABC123',
    ]) {
      expect(() => assertSafeRunDirectory(unsafe)).toThrow(/unsafe/i)
    }
  })
})

describe('computer-use live smoke state evidence', () => {
  test('parses a complete system snapshot and rejects unproven foreground identity', () => {
    expect(parseSystemSnapshot(JSON.stringify(initialSystemSnapshot))).toEqual(
      initialSystemSnapshot,
    )

    expect(() =>
      parseSystemSnapshot(
        JSON.stringify({
          ...initialSystemSnapshot,
          frontmost: { ...initialSystemSnapshot.frontmost, launchTime: null },
        }),
      ),
    ).toThrow(/frontmost/i)
  })

  test('accepts at most one pixel of pointer drift with exact foreground and held-input state', () => {
    expect(() =>
      assertSystemStatePreserved(initialSystemSnapshot, {
        ...initialSystemSnapshot,
        pointer: { x: 100.6, y: 200.6 },
      }),
    ).not.toThrow()

    expect(() =>
      assertSystemStatePreserved(initialSystemSnapshot, {
        ...initialSystemSnapshot,
        pointer: { x: 101.01, y: 200 },
      }),
    ).toThrow(/pointer drift/i)
  })

  test('rejects PID reuse, foreground replacement, and stuck input state', () => {
    expect(() =>
      assertSystemStatePreserved(initialSystemSnapshot, {
        ...initialSystemSnapshot,
        frontmost: { ...initialSystemSnapshot.frontmost, launchTime: 9999 },
      }),
    ).toThrow(/frontmost identity/i)

    expect(() =>
      assertSystemStatePreserved(initialSystemSnapshot, {
        ...initialSystemSnapshot,
        input: {
          ...initialSystemSnapshot.input,
          buttons: [true, false, false, false, false],
        },
      }),
    ).toThrow(/held input/i)
  })

  test('rejects transient pointer movement even if the endpoint was restored', () => {
    expect(() => assertPointerTrace({ samples: 50, maxDriftPx: 0.8 })).not.toThrow()
    expect(() => assertPointerTrace({ samples: 50, maxDriftPx: 12 })).toThrow(
      /transiently/i,
    )
    expect(() => assertPointerTrace({ samples: 1, maxDriftPx: 0 })).toThrow(
      /too few samples/i,
    )
  })

  test('requires an available, continuous physical-input monitor', () => {
    const before = parseInputMonitorSnapshot({
      epoch: '42',
      available: true,
      continuityGeneration: '3',
    })
    const after = parseInputMonitorSnapshot({
      epoch: '42',
      available: true,
      continuityGeneration: '3',
    })
    expect(() => assertMonitorContinuity(before, after)).not.toThrow()

    expect(() =>
      parseInputMonitorSnapshot({
        epoch: '42',
        available: false,
        continuityGeneration: '3',
      }),
    ).toThrow(/physical-input monitor/i)

    expect(() =>
      assertMonitorContinuity(before, { ...after, epoch: 43n }),
    ).toThrow(/physical input/i)
    expect(() =>
      assertMonitorContinuity(before, {
        ...after,
        continuityGeneration: 4n,
      }),
    ).toThrow(/continuity/i)
  })
})

describe('computer-use live smoke AX proof', () => {
  test('wait predicates reject transiently missing captures', () => {
    expect(hasFreshScreenshot(state())).toBe(true)
    expect(hasFreshScreenshot(state({ screenshot: undefined }))).toBe(false)
    expect(hasFreshScreenshot(state({
      screenshot: { base64: 'not-a-png', width: 1, height: 1 },
    }))).toBe(false)
  })

  test('derives an opaque editable handle from raw element metadata plus rendered generation', () => {
    expect(findEditableHandle(state(), 'CC_HAHA_SMOKE_STABLE_TOKEN')).toBe(
      'g8:7',
    )
  })

  test('rejects ambiguous or non-settable editable elements', () => {
    expect(() =>
      findEditableHandle(
        state({
          elements: [
            {
              index: 7,
              role: 'AXTextArea',
              settable: false,
              value: 'CC_HAHA_SMOKE_STABLE_TOKEN',
            },
          ],
        }),
        'CC_HAHA_SMOKE_STABLE_TOKEN',
      ),
    ).toThrow(/exactly one/i)

    expect(() =>
      findEditableHandle(
        state({
          elements: [
            {
              index: 7,
              role: 'AXTextArea',
              settable: true,
              value: 'CC_HAHA_SMOKE_STABLE_TOKEN',
            },
            {
              index: 8,
              role: 'AXTextField',
              settable: true,
              value: 'CC_HAHA_SMOKE_STABLE_TOKEN',
            },
          ],
          axText:
            'g8:7 text area CC_HAHA_SMOKE_STABLE_TOKEN\ng8:8 text field CC_HAHA_SMOKE_STABLE_TOKEN',
        }),
        'CC_HAHA_SMOKE_STABLE_TOKEN',
      ),
    ).toThrow(/exactly one/i)
  })

  test('requires the exact no-change header and a changed diff with a real screenshot', () => {
    expect(hasExactNoChangeState(state({
      axText:
        'There has been no change in the accessibility tree for Window: "smoke-fixture.txt".',
    }))).toBe(true)
    expect(hasExactNoChangeState(state({
      axText:
        'The following is a diff from the previous accessibility tree for Window: "smoke-fixture.txt".',
    }))).toBe(false)

    expect(() =>
      assertNoChangeState(
        state({
          axText:
            'There has been no change in the accessibility tree for Window: "smoke-fixture.txt".',
        }),
      ),
    ).not.toThrow()

    expect(() =>
      assertNoChangeState(state({ axText: 'g8:0 standard window' })),
    ).toThrow(/no-change/i)

    expect(() =>
      assertChangedState(
        state({
          axText:
            'The following is a diff from the previous accessibility tree for Window: "smoke-fixture.txt" with ~ and + representing changed and added elements, respectively. Removed elements are summarized by ID range.\n~\tg8:7 text area MUTATED',
        }),
        'MUTATED',
      ),
    ).not.toThrow()

    expect(() =>
      assertChangedState(
        state({
          axText:
            'The following is a diff from the previous accessibility tree for Window: "smoke-fixture.txt" with ~ and + representing changed and added elements, respectively. Removed elements are summarized by ID range.\n~\tg8:7 text area MUTATED',
          screenshot: { base64: '', width: 0, height: 0 },
        }),
        'MUTATED',
      ),
    ).toThrow(/screenshot/i)
  })

  test('rejects fake PNG text and reused mutation screenshots', () => {
    expect(() =>
      assertNoChangeState(
        state({
          axText:
            'There has been no change in the accessibility tree for Window: "smoke-fixture.txt".',
          screenshot: { base64: 'a'.repeat(128), width: 1, height: 1 },
        }),
      ),
    ).toThrow(/PNG|screenshot/i)

    expect(() => assertScreenshotChanged(state(), state())).toThrow(/reused/i)
    expect(() =>
      assertScreenshotChanged(
        state(),
        state({ screenshot: { base64: PNG_TWO, width: 1, height: 1 } }),
      ),
    ).not.toThrow()
  })

  test('accepts only an authoritative stale-handle failure', () => {
    expect(() =>
      assertStaleHandleFailure(
        new Error(
          'Snapshot handle g9:4 is stale. Re-query the latest state with get_app_state before sending more actions.',
        ),
      ),
    ).not.toThrow()

    expect(() =>
      assertStaleHandleFailure(new Error('Accessibility permission is required')),
    ).toThrow(/not a stale-handle/i)
  })
})

describe('computer-use live smoke cleanup proof', () => {
  test('requires socket, pidfile, owned daemon, and held input to be gone', () => {
    expect(() =>
      assertCleanupEvidence({
        daemonSocketExists: false,
        daemonPidfileExists: false,
        daemonProcessStillMatches: false,
        inputBefore: initialSystemSnapshot.input,
        inputAfter: initialSystemSnapshot.input,
      }),
    ).not.toThrow()

    expect(() =>
      assertCleanupEvidence({
        daemonSocketExists: true,
        daemonPidfileExists: false,
        daemonProcessStillMatches: false,
        inputBefore: initialSystemSnapshot.input,
        inputAfter: initialSystemSnapshot.input,
      }),
    ).toThrow(/socket/i)
  })
})
