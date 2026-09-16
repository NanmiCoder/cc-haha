import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, test } from 'bun:test'

import type {
  ComputerExecutor,
  DisplayGeometry,
  ScreenshotResult,
} from './executor.js'
import { bindSessionContext, createComputerUseMcpServer } from './mcpServer.js'
import { NATIVE_CALL_NOT_DISPATCHED } from './toolCalls.js'
import { resetMouseButtonHeld } from './windowsLegacyToolCalls.js'
import type {
  ComputerUseHostAdapter,
  ComputerUseSessionContext,
} from './types.js'

const DARWIN_TOOL_NAMES = [
  'js',
  'js_reset',
].sort()

const WINDOWS_LEGACY_TOOL_NAMES = [
  'screenshot',
  'zoom',
  'left_click',
  'double_click',
  'triple_click',
  'right_click',
  'middle_click',
  'type',
  'key',
  'scroll',
  'left_click_drag',
  'mouse_move',
  'open_application',
  'switch_display',
  'read_clipboard',
  'write_clipboard',
  'wait',
  'cursor_position',
  'hold_key',
  'left_mouse_down',
  'left_mouse_up',
  'computer_batch',
  'request_teach_access',
  'teach_step',
  'teach_batch',
].sort()

const logger = {
  silly() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
}

afterEach(() => resetMouseButtonHeld())

function makeSessionContext(
  overrides: Partial<ComputerUseSessionContext> = {},
): ComputerUseSessionContext {
  return {
    getAllowedApps: () => [],
    getGrantFlags: () => ({
      clipboardRead: false,
      clipboardWrite: false,
      systemKeyCombos: false,
    }),
    getUserDeniedBundleIds: () => [],
    getSelectedDisplayId: () => undefined,
    onPermissionRequest: async () => {
      throw new Error('per-app permission prompts must not run')
    },
    ...overrides,
  }
}

async function connect(
  adapter: ComputerUseHostAdapter,
  context?: ComputerUseSessionContext,
) {
  const server = createComputerUseMcpServer(adapter, 'pixels', context)
  const client = new Client(
    { name: 'computer-use-platform-routing-test', version: '1.0.0' },
    { capabilities: {} },
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

function makeDarwinAdapter(): ComputerUseHostAdapter {
  const executor = {
    capabilities: {
      screenshotFiltering: 'native',
      platform: 'darwin',
      hostBundleId: 'com.example.host',
    },
  } as unknown as ComputerExecutor
  return {
    serverName: 'computer-use',
    logger,
    executor,
    ensureOsPermissions: async () => ({ granted: true }),
    isDisabled: () => false,
    getSubGates: () => ({
      pixelValidation: false,
      clipboardPasteMultiline: false,
      mouseAnimation: false,
      hideBeforeAction: false,
      autoTargetDisplay: false,
      clipboardGuard: false,
    }),
    getAutoUnhideEnabled: () => true,
    cropRawPatch: () => null,
  }
}

function makeWindowsAdapter(calls: string[]): ComputerUseHostAdapter {
  const display: DisplayGeometry = {
    id: 1,
    displayId: 1,
    width: 100,
    height: 80,
    scaleFactor: 1,
    originX: 0,
    originY: 0,
    isPrimary: true,
    label: 'Test Display',
  }
  const screenshot: ScreenshotResult = {
    base64: Buffer.alloc(5_000, 1).toString('base64'),
    width: 100,
    height: 80,
    displayWidth: 100,
    displayHeight: 80,
    displayId: 1,
    originX: 0,
    originY: 0,
  }

  const executor = {
    capabilities: {
      screenshotFiltering: 'none',
      platform: 'win32',
      hostBundleId: 'com.example.host',
      teachMode: true,
    },
    // Deliberately no semantic `engine`: a real Windows executor is pixel-only.
    async prepareForAction() {
      calls.push('prepareForAction')
      return ['com.example.hidden']
    },
    async previewHideSet() {
      return []
    },
    async getDisplaySize() {
      calls.push('getDisplaySize')
      return display
    },
    async listDisplays() {
      calls.push('listDisplays')
      return [display]
    },
    async findWindowDisplays() {
      return []
    },
    async resolvePrepareCapture() {
      throw new Error('auto-target path should not run in this fixture')
    },
    async screenshot() {
      calls.push('screenshot')
      return screenshot
    },
    async zoom() {
      return { base64: screenshot.base64, width: 100, height: 80 }
    },
    async key(keySequence: string) {
      calls.push(`key:${keySequence}`)
    },
    async holdKey(keyNames: string[]) {
      calls.push(`holdKey:${keyNames.join('+')}`)
    },
    async type(text: string) {
      calls.push(`type:${text}`)
    },
    async readClipboard() {
      return ''
    },
    async writeClipboard() {},
    async click(x: number, y: number, button: string, count: number) {
      calls.push(`click:${x},${y},${button},${count}`)
    },
    async mouseDown() {
      calls.push('mouseDown')
    },
    async mouseUp() {
      calls.push('mouseUp')
    },
    async getCursorPosition() {
      return { x: 0, y: 0 }
    },
    async drag() {},
    async moveMouse() {},
    async scroll() {},
    async getFrontmostApp() {
      calls.push('getFrontmostApp')
      return {
        bundleId: 'com.example.allowed',
        displayName: 'Allowed App',
      }
    },
    async appUnderPoint() {
      calls.push('appUnderPoint')
      return {
        bundleId: 'com.example.allowed',
        displayName: 'Allowed App',
      }
    },
    async listInstalledApps() {
      return [
        {
          bundleId: 'com.example.allowed',
          displayName: 'Allowed App',
          path: 'C:\\Program Files\\Allowed App\\Allowed.exe',
        },
      ]
    },
    async listRunningApps() {
      calls.push('listRunningApps')
      return [
        {
          bundleId: 'com.example.hidden',
          displayName: 'Hidden App',
        },
      ]
    },
    async openApp(bundleId: string) {
      calls.push(`openApp:${bundleId}`)
    },
  } as unknown as ComputerExecutor

  return {
    serverName: 'computer-use',
    logger,
    executor,
    ensureOsPermissions: async () => ({ granted: true }),
    isDisabled: () => false,
    getSubGates: () => ({
      pixelValidation: false,
      clipboardPasteMultiline: false,
      mouseAnimation: false,
      hideBeforeAction: true,
      autoTargetDisplay: false,
      clipboardGuard: false,
    }),
    getAutoUnhideEnabled: () => true,
    cropRawPatch: () => null,
  }
}

describe('Computer Use platform routing', () => {
  test('win32 pre-cancelled single click and key calls never dispatch input', async () => {
    const calls: string[] = []
    let tccChecks = 0
    let lockChecks = 0
    const adapter = makeWindowsAdapter(calls)
    adapter.ensureOsPermissions = async () => {
      tccChecks += 1
      return { granted: true }
    }
    const dispatch = bindSessionContext(
      adapter,
      'pixels',
      makeSessionContext({
        checkCuLock: async () => {
          lockChecks += 1
          return { holder: undefined, isSelf: false }
        },
      }),
    )
    const controller = new AbortController()
    controller.abort()

    const results = await Promise.all([
      dispatch('left_click', { coordinate: [10, 20] }, controller.signal),
      dispatch('key', { text: 'ctrl+a' }, controller.signal),
    ])

    expect(calls).not.toContain('click:10,20,left,1')
    expect(calls).not.toContain('key:ctrl+a')
    expect(results.every(result => result.isError === true)).toBe(true)
    expect(tccChecks).toBe(0)
    expect(lockChecks).toBe(0)
  })

  test('win32 cancellation while awaiting the lock check never acquires or dispatches', async () => {
    const calls: string[] = []
    let releaseLockCheck!: (value: { holder: undefined; isSelf: false }) => void
    const lockCheck = new Promise<{ holder: undefined; isSelf: false }>(resolve => {
      releaseLockCheck = resolve
    })
    let acquireCount = 0
    const dispatch = bindSessionContext(
      makeWindowsAdapter(calls),
      'pixels',
      makeSessionContext({
        checkCuLock: async () => lockCheck,
        acquireCuLock: async () => { acquireCount += 1 },
      }),
    )
    const controller = new AbortController()
    const pending = dispatch('key', { text: 'ctrl+a' }, controller.signal)

    controller.abort()
    releaseLockCheck({ holder: undefined, isSelf: false })
    const result = await pending

    expect(acquireCount).toBe(0)
    expect(calls).not.toContain('key:ctrl+a')
    expect(result.isError).toBe(true)
  })

  test('win32 cancellation during lock acquisition never dispatches new input', async () => {
    const calls: string[] = []
    let acquired = false
    let enteredAcquire!: () => void
    let finishAcquire!: () => void
    const acquiring = new Promise<void>(resolve => { enteredAcquire = resolve })
    const acquireGate = new Promise<void>(resolve => { finishAcquire = resolve })
    const dispatch = bindSessionContext(makeWindowsAdapter(calls), 'pixels', makeSessionContext({
      checkCuLock: async () => acquired
        ? { holder: 'self', isSelf: true }
        : { holder: undefined, isSelf: false },
      acquireCuLock: async () => {
        enteredAcquire()
        await acquireGate
        acquired = true
      },
    }))
    const controller = new AbortController()
    const pending = dispatch('key', { text: 'ctrl+a' }, controller.signal)
    await acquiring
    controller.abort()
    finishAcquire()

    const result = await pending
    expect(result.isError).toBe(true)
    expect(calls).not.toContain('key:ctrl+a')
  })

  test('win32 cancellation while awaiting OS permissions never dispatches click or key input', async () => {
    const calls: string[] = []
    const adapter = makeWindowsAdapter(calls)
    let permissionsEntered!: () => void
    let finishPermissions!: (value: { granted: true }) => void
    const checking = new Promise<void>(resolve => { permissionsEntered = resolve })
    const permissionGate = new Promise<{ granted: true }>(resolve => { finishPermissions = resolve })
    adapter.ensureOsPermissions = async () => {
      permissionsEntered()
      return permissionGate
    }
    const dispatch = bindSessionContext(adapter, 'pixels', makeSessionContext())
    const controller = new AbortController()
    const pending = Promise.all([
      dispatch('left_click', { coordinate: [10, 20] }, controller.signal),
      dispatch('key', { text: 'ctrl+a' }, controller.signal),
    ])
    await checking
    controller.abort()
    finishPermissions({ granted: true })

    const results = await pending
    expect(calls).not.toContain('click:10,20,left,1')
    expect(calls).not.toContain('key:ctrl+a')
    expect(results.every(result => result.isError === true)).toBe(true)
  })

  test('win32 cancellation releases this binder held mouse once without dispatching the requested key', async () => {
    const calls: string[] = []
    const dispatch = bindSessionContext(makeWindowsAdapter(calls), 'pixels', makeSessionContext())
    expect((await dispatch('left_mouse_down', {})).isError).toBeFalsy()
    const controller = new AbortController()
    controller.abort()

    expect((await dispatch('key', { text: 'ctrl+a' }, controller.signal)).isError).toBe(true)
    expect((await dispatch('left_mouse_up', {}, controller.signal)).isError).toBe(true)
    expect(calls.filter(call => call === 'mouseUp')).toHaveLength(1)
    expect(calls).not.toContain('key:ctrl+a')
  })

  test('win32 cancellation cannot release another binder held mouse', async () => {
    const ownerCalls: string[] = []
    const otherCalls: string[] = []
    const owner = bindSessionContext(makeWindowsAdapter(ownerCalls), 'pixels', makeSessionContext())
    const other = bindSessionContext(makeWindowsAdapter(otherCalls), 'pixels', makeSessionContext())
    expect((await owner('left_mouse_down', {})).isError).toBeFalsy()
    const controller = new AbortController()
    controller.abort()

    expect((await other('left_mouse_up', {}, controller.signal)).isError).toBe(true)
    expect(otherCalls).not.toContain('mouseUp')
    await owner('left_mouse_up', {}, controller.signal)
    expect(ownerCalls.filter(call => call === 'mouseUp')).toHaveLength(1)
  })

  test('win32 cancellation does not release a held mouse after losing the global lock', async () => {
    const calls: string[] = []
    let isSelf = true
    const dispatch = bindSessionContext(makeWindowsAdapter(calls), 'pixels', makeSessionContext({
      checkCuLock: async () => ({ holder: isSelf ? 'self' : 'other', isSelf }),
    }))
    expect((await dispatch('left_mouse_down', {})).isError).toBeFalsy()
    const controller = new AbortController()
    controller.abort()
    isSelf = false

    expect((await dispatch('left_mouse_up', {}, controller.signal)).isError).toBe(true)
    expect(calls).not.toContain('mouseUp')
    isSelf = true
    await dispatch('left_mouse_up', {}, controller.signal)
    expect(calls.filter(call => call === 'mouseUp')).toHaveLength(1)
  })

  test('win32 cancelled mouse release failures stay visible and preserve recovery ownership', async () => {
    const calls: string[] = []
    const adapter = makeWindowsAdapter(calls)
    let releaseAttempts = 0
    adapter.executor.mouseUp = async () => {
      releaseAttempts += 1
      if (releaseAttempts === 1) throw new Error('Windows release fixture failed')
      calls.push('mouseUp')
    }
    const dispatch = bindSessionContext(adapter, 'pixels', makeSessionContext())
    expect((await dispatch('left_mouse_down', {})).isError).toBeFalsy()
    const controller = new AbortController()
    controller.abort()

    const failed = await dispatch('key', { text: 'ctrl+a' }, controller.signal)
    expect(failed.isError).toBe(true)
    expect(failed.content).toContainEqual(expect.objectContaining({
      type: 'text', text: expect.stringContaining('Windows release fixture failed'),
    }))
    await dispatch('left_mouse_up', {}, controller.signal)
    await dispatch('left_mouse_up', {}, controller.signal)
    expect(releaseAttempts).toBe(2)
    expect(calls.filter(call => call === 'mouseUp')).toHaveLength(1)
    expect(calls).not.toContain('key:ctrl+a')
  })

  test('win32 simultaneous cancelled calls share one owned mouse release', async () => {
    const calls: string[] = []
    const adapter = makeWindowsAdapter(calls)
    let releaseEntered!: () => void
    let finishRelease!: () => void
    const releasing = new Promise<void>(resolve => { releaseEntered = resolve })
    const releaseGate = new Promise<void>(resolve => { finishRelease = resolve })
    adapter.executor.mouseUp = async () => {
      calls.push('mouseUp')
      releaseEntered()
      await releaseGate
    }
    const dispatch = bindSessionContext(adapter, 'pixels', makeSessionContext())
    await dispatch('left_mouse_down', {})
    const controller = new AbortController()
    controller.abort()
    const first = dispatch('left_mouse_up', {}, controller.signal)
    await releasing
    const second = dispatch('left_mouse_up', {}, controller.signal)
    finishRelease()
    const results = await Promise.all([first, second])

    expect(results.every(result => result.isError === true)).toBe(true)
    expect(calls.filter(call => call === 'mouseUp')).toHaveLength(1)
  })

  test('win32 cancellation during mouse-down releases after completion without claiming no dispatch', async () => {
    const calls: string[] = []
    const adapter = makeWindowsAdapter(calls)
    let downEntered!: () => void
    let finishDown!: () => void
    const entering = new Promise<void>(resolve => { downEntered = resolve })
    const downGate = new Promise<void>(resolve => { finishDown = resolve })
    adapter.executor.mouseDown = async () => {
      calls.push('mouseDown')
      downEntered()
      await downGate
    }
    const dispatch = bindSessionContext(adapter, 'pixels', makeSessionContext())
    const controller = new AbortController()
    const pending = dispatch('left_mouse_down', {}, controller.signal)
    await entering
    controller.abort()
    finishDown()

    const result = await pending
    expect(calls.filter(call => ['mouseDown', 'mouseUp'].includes(call))).toEqual(['mouseDown', 'mouseUp'])
    expect(result.isError).toBe(true)
    expect(result[NATIVE_CALL_NOT_DISPATCHED]).not.toBe(true)
  })

  test('win32 mid-batch cancellation releases its held mouse and skips later actions', async () => {
    const calls: string[] = []
    const adapter = makeWindowsAdapter(calls)
    const controller = new AbortController()
    adapter.executor.mouseDown = async () => {
      calls.push('mouseDown')
      controller.abort()
    }
    const dispatch = bindSessionContext(adapter, 'pixels', makeSessionContext())
    const result = await dispatch('computer_batch', {
      actions: [{ action: 'left_mouse_down' }, { action: 'key', text: 'ctrl+a' }],
    }, controller.signal)

    expect(result.isError).toBe(true)
    expect(calls.filter(call => ['mouseDown', 'mouseUp'].includes(call))).toEqual(['mouseDown', 'mouseUp'])
    expect(calls).not.toContain('key:ctrl+a')
  })

  test('win32 mid-batch cancellation cannot release its mouse after losing the global lock', async () => {
    const calls: string[] = []
    const adapter = makeWindowsAdapter(calls)
    const controller = new AbortController()
    let isSelf = true
    adapter.executor.mouseDown = async () => {
      calls.push('mouseDown')
      isSelf = false
      controller.abort()
    }
    const dispatch = bindSessionContext(adapter, 'pixels', makeSessionContext({
      checkCuLock: async () => ({ holder: isSelf ? 'self' : 'other', isSelf }),
    }))
    const result = await dispatch('computer_batch', {
      actions: [{ action: 'left_mouse_down' }, { action: 'key', text: 'ctrl+a' }],
    }, controller.signal)

    expect(result.isError).toBe(true)
    expect(calls).not.toContain('mouseUp')
    expect(calls).not.toContain('key:ctrl+a')
    isSelf = true
    await dispatch('left_mouse_up', {}, controller.signal)
    expect(calls.filter(call => call === 'mouseUp')).toHaveLength(1)
  })

  test('darwin ListTools advertises the current semantic tools', async () => {
    const connection = await connect(makeDarwinAdapter())
    try {
      const result = await connection.client.listTools()
      expect(result.tools.map(tool => tool.name).sort()).toEqual(DARWIN_TOOL_NAMES)
    } finally {
      await connection.close()
    }
  })

  test('darwin MCP rejects static bad_args before TCC and the async session lock', async () => {
    let tccChecks = 0
    let lockChecks = 0
    let lockAcquires = 0
    const adapter = makeDarwinAdapter()
    adapter.ensureOsPermissions = async () => {
      tccChecks += 1
      return { granted: false }
    }
    const connection = await connect(
      adapter,
      makeSessionContext({
        checkCuLock: async () => {
          lockChecks += 1
          return { holder: undefined, isSelf: false }
        },
        acquireCuLock: async () => {
          lockAcquires += 1
        },
      }),
    )

    try {
      const result = await connection.client.callTool({
        name: 'click',
        arguments: { app: 'Finder', x: 10 },
      })
      expect(result.isError).toBe(true)
      expect(result.content).toEqual([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('click x and y must be provided together'),
        }),
      ])
      expect(tccChecks).toBe(0)
      expect(lockChecks).toBe(0)
      expect(lockAcquires).toBe(0)
    } finally {
      await connection.close()
    }
  })

  test('win32 ListTools advertises pixel controls without app-authorization tools', async () => {
    const connection = await connect(makeWindowsAdapter([]))
    try {
      const result = await connection.client.listTools()
      expect(result.tools.map(tool => tool.name).sort()).toEqual(
        WINDOWS_LEGACY_TOOL_NAMES,
      )
      expect(result.tools.some(tool => tool.name === 'get_app_state')).toBe(false)
      expect(result.tools.some(tool => tool.name === 'sequence')).toBe(false)
      expect(result.tools.some(tool => tool.name === 'request_access')).toBe(false)
      expect(result.tools.some(tool => tool.name === 'list_granted_applications')).toBe(false)
    } finally {
      await connection.close()
    }
  })

  test('win32 MCP calls reach the legacy pixel/Python executor surface', async () => {
    const calls: string[] = []
    const connection = await connect(
      makeWindowsAdapter(calls),
      makeSessionContext(),
    )
    try {
      expect((await connection.client.callTool({ name: 'screenshot' })).isError).toBeFalsy()
      expect((await connection.client.callTool({ name: 'screenshot' })).isError).toBeFalsy()
      expect(
        (
          await connection.client.callTool({
            name: 'left_click',
            arguments: { coordinate: [10, 20] },
          })
        ).isError,
      ).toBeFalsy()
      expect(
        (
          await connection.client.callTool({
            name: 'key',
            arguments: { text: 'ctrl+a' },
          })
        ).isError,
      ).toBeFalsy()
      expect(
        (
          await connection.client.callTool({
            name: 'type',
            arguments: { text: 'ok' },
          })
        ).isError,
      ).toBeFalsy()

      expect(calls).toContain('screenshot')
      expect(calls).not.toContain('listRunningApps')
      expect(calls).toContain('click:10,20,left,1')
      expect(calls).toContain('key:ctrl+a')
      expect(calls).toContain('type:ok')
      expect(calls).not.toContain('type:o')
      expect(calls).not.toContain('type:k')

      const blockedKey = await connection.client.callTool({
        name: 'key',
        arguments: { text: 'ctrl+alt+delete' },
      })
      const blockedHold = await connection.client.callTool({
        name: 'hold_key',
        arguments: { text: 'alt+f4', duration: 0.1 },
      })
      expect(blockedKey.isError).toBe(true)
      expect(blockedHold.isError).toBe(true)
      expect(calls).not.toContain('key:ctrl+alt+delete')
      expect(calls).not.toContain('holdKey:alt+f4')

      const opened = await connection.client.callTool({
        name: 'open_application',
        arguments: { app: 'Allowed App' },
      })
      expect(opened.isError).toBeFalsy()
      expect(calls).toContain('openApp:com.example.allowed')
    } finally {
      await connection.close()
    }
  })

  test('win32 binder preserves legacy lock deferral and clears stale mouse state on acquire', async () => {
    // Seed the legacy module's cross-call drag state, as if a prior session
    // disconnected after left_mouse_down but before left_mouse_up.
    const seedCalls: string[] = []
    const seed = await connect(
      makeWindowsAdapter(seedCalls),
      makeSessionContext(),
    )
    try {
      const result = await seed.client.callTool({ name: 'left_mouse_down' })
      expect(result.isError).toBeFalsy()
      expect(seedCalls).toContain('mouseDown')
    } finally {
      await seed.close()
    }

    let lockHeld = false
    let acquireCount = 0
    const calls: string[] = []
    const connection = await connect(
      makeWindowsAdapter(calls),
      makeSessionContext({
        checkCuLock: async () =>
          lockHeld
            ? { holder: 'this-session', isSelf: true }
            : { holder: undefined, isSelf: false },
        acquireCuLock: async () => {
          acquireCount += 1
          lockHeld = true
        },
      }),
    )
    try {
      // The first action takes the lock and must clear the prior session's
      // module-level mouseButtonHeld flag before dispatching.
      const screenshot = await connection.client.callTool({ name: 'screenshot' })
      expect(screenshot.isError).toBeFalsy()
      expect(acquireCount).toBe(1)

      const down = await connection.client.callTool({ name: 'left_mouse_down' })
      expect(down.isError).toBeFalsy()
      expect(calls).toContain('mouseDown')
      const up = await connection.client.callTool({ name: 'left_mouse_up' })
      expect(up.isError).toBeFalsy()
      expect(calls).toContain('mouseUp')
    } finally {
      await connection.close()
    }
  })

  test('win32 retries a legacy clipboard stash restore without clearing clipboard by app', async () => {
    const calls: string[] = []
    const adapter = makeWindowsAdapter(calls)
    let stash: string | undefined = 'preserved clipboard'
    let clipboard = 'current clipboard'
    let writeAttempts = 0
    adapter.executor.getFrontmostApp = async () => ({
      bundleId: 'powershell.exe', displayName: 'PowerShell',
    })
    adapter.executor.readClipboard = async () => clipboard
    adapter.executor.writeClipboard = async text => {
      writeAttempts += 1
      if (writeAttempts === 1) throw new Error('clipboard temporarily busy')
      clipboard = text
    }
    const getSubGates = adapter.getSubGates
    adapter.getSubGates = () => ({ ...getSubGates(), clipboardGuard: true })
    const connection = await connect(adapter, makeSessionContext({
      getClipboardStash: () => stash,
      onClipboardStashChanged: value => { stash = value },
      getGrantFlags: () => ({ clipboardRead: true, clipboardWrite: true, systemKeyCombos: true }),
    }))
    try {
      expect((await connection.client.callTool({ name: 'read_clipboard' })).isError).toBeFalsy()
      expect(stash).toBe('preserved clipboard')
      expect(clipboard).toBe('current clipboard')
      expect((await connection.client.callTool({ name: 'read_clipboard' })).isError).toBeFalsy()
      expect(stash).toBeUndefined()
      expect(clipboard).toBe('preserved clipboard')
      expect(writeAttempts).toBe(2)

      expect((await connection.client.callTool({
        name: 'write_clipboard', arguments: { text: 'new clipboard' },
      })).isError).toBeFalsy()
      expect((await connection.client.callTool({
        name: 'key', arguments: { text: 'ctrl+v' },
      })).isError).toBeFalsy()
      expect(clipboard).toBe('new clipboard')
      expect(stash).toBeUndefined()
      expect(writeAttempts).toBe(3)
      expect(calls).toContain('key:ctrl+v')
    } finally {
      await connection.close()
    }
  })

  test.each([
    ['chrome.exe', 'Google Chrome'],
    ['powershell.exe', 'PowerShell'],
    ['spotify.exe', 'Spotify'],
    ['tradingview.exe', 'TradingView'],
    ['com.example.host', 'Claude Code Haha'],
    ['dev.cchaha.cu-helper', 'Computer Use Helper'],
  ])('win32 global consent permits input, launch, and clipboard for %s', async (bundleId, displayName) => {
    const calls: string[] = []
    const adapter = makeWindowsAdapter(calls)
    const app = { bundleId, displayName }
    let frontmost = app
    let clipboard = 'existing clipboard'
    adapter.executor.getFrontmostApp = async () => frontmost
    adapter.executor.appUnderPoint = async () => app
    adapter.executor.listInstalledApps = async () => [{ ...app, path: `C:\\Apps\\${bundleId}` }]
    adapter.executor.readClipboard = async () => clipboard
    adapter.executor.writeClipboard = async text => { clipboard = text }
    const getSubGates = adapter.getSubGates
    adapter.getSubGates = () => ({ ...getSubGates(), clipboardGuard: true })
    const connection = await connect(adapter, makeSessionContext({
      // Cached state from the old app-specific model cannot narrow the
      // feature-wide consent given when Computer Use was enabled.
      getAllowedApps: () => [{ ...app, grantedAt: 1, tier: 'read' }],
      getUserDeniedBundleIds: () => [bundleId],
      getGrantFlags: () => ({ clipboardRead: true, clipboardWrite: true, systemKeyCombos: true }),
    }))
    try {
      for (const request of [
        { name: 'screenshot' },
        { name: 'open_application', arguments: { app: displayName } },
        { name: 'key', arguments: { text: 'ctrl+a' } },
        { name: 'type', arguments: { text: 'ok' } },
        { name: 'read_clipboard' },
      ]) {
        const result = await connection.client.callTool(request)
        expect(result.isError, `${request.name}: ${JSON.stringify(result.content)}`).toBeFalsy()
      }
      expect(clipboard).toBe('existing clipboard')
      expect((await connection.client.callTool({
        name: 'write_clipboard', arguments: { text: 'new clipboard' },
      })).isError).toBeFalsy()
      expect(clipboard).toBe('new clipboard')

      // Coordinate clicks remain authorized regardless of which application
      // is foreground or owns the window receiving the click.
      frontmost = { bundleId: 'notepad.exe', displayName: 'Notepad' }
      expect((await connection.client.callTool({
        name: 'right_click', arguments: { coordinate: [10, 20] },
      })).isError).toBeFalsy()
      expect(calls).toContain(`openApp:${bundleId}`)
      expect(calls).toContain('key:ctrl+a')
      expect(calls).toContain('type:ok')
      expect(calls).toContain('click:10,20,right,1')
      expect(clipboard).toBe('new clipboard')
    } finally {
      await connection.close()
    }
  })
})
