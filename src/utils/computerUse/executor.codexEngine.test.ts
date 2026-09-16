/**
 * Integration test for the host CLI executor's Codex semantic `engine` and its
 * alignment with the native daemon's `CommandRouter` command contract.
 *
 * We mock `./helperBridge.js` so every `callHelper(<cmd>, payload)` the engine
 * makes is captured, then drive the engine through BOTH:
 *   - the engine methods directly (payload-key alignment with CommandRouter), and
 *   - the real MCP dispatch (`handleToolCall`) so the tool face ↔ engine ↔
 *     daemon-payload round-trip is exercised end-to-end.
 *
 * These guard the integration boundary the blueprint cares about (§4–§7): the
 * ten semantic tools must reach the daemon with the exact payload keys
 * CommandRouter decodes (pid/bundleId/app, index, click_count, button, value,
 * action, direction, pages, from/to, key, text), and `list_apps` must render the
 * daemon's structured `AppRef[]` into the text block the tool face surfaces.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Capture every callHelper invocation. The factory's `calls` array is closed
// over by the mock and reset per test via the exported handle.
const calls: Array<{ command: string; payload: Record<string, unknown> }> = []
let nextResult: unknown = true
let nextResolvedTarget: unknown = {
  pid: 1106,
  bundleId: 'com.apple.finder',
  displayName: 'Finder',
  path: '/System/Library/CoreServices/Finder.app',
  executablePath: '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder',
  launchTime: 2106,
}

mock.module('./helperBridge.js', () => ({
  callHelper: async (command: string, payload: Record<string, unknown> = {}) => {
    calls.push({ command, payload })
    return command === 'resolve_app_target' ? nextResolvedTarget : nextResult
  },
  __resetHelperBridgeState: () => {},
}))

// The host adapter pulls in heavy provider chains via analytics; the engine
// itself only needs the executor + handleToolCall, so import those directly.
async function loadExecutor() {
  const { createCliExecutor } = await import('./executor.js')
  return createCliExecutor({
    getMouseAnimationEnabled: () => false,
    getHideBeforeActionEnabled: () => false,
  })
}

function lastCall() {
  return calls[calls.length - 1]
}

describe('CLI executor Codex engine — daemon payload alignment', () => {
  beforeEach(() => {
    calls.length = 0
    nextResult = true
    nextResolvedTarget = {
      pid: 1106,
      bundleId: 'com.apple.finder',
      displayName: 'Finder',
      path: '/System/Library/CoreServices/Finder.app',
      executablePath: '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder',
      launchTime: 2106,
    }
  })

  test('engine is present on darwin', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      // createCliExecutor intentionally rejects unsupported hosts. The exported
      // pure engine-factory contract below still runs on every CI platform.
      return
    }
    const exec = await loadExecutor()
    // This suite only runs meaningfully on macOS (the native AX path). Skip the
    // assertion off-darwin rather than failing CI on a non-mac runner.
    if (process.platform === 'darwin') {
      expect(exec.engine).toBeDefined()
    } else {
      expect(exec.engine).toBeUndefined()
    }
  })

  // The remaining cases require the engine; guard once.
  const itEngine = process.platform === 'darwin' ? test : test.skip

  test('resolveTarget maps aliases, paths, and pids to resolve_app_target without launching', async () => {
    const { createCodexEngine } = await import('./executor.js')
    const engine = createCodexEngine()
    for (const target of [
      { app: 'Finder' },
      { app: '/System/Applications/TextEdit.app' },
      { pid: 812 },
    ]) {
      nextResolvedTarget = {
        pid: target.pid,
        bundleId: 'com.test.target',
        displayName: 'Target',
        path: target.app,
      }
      const resolved = await engine.resolveTarget(target)
      expect(lastCall()).toEqual({
        command: 'resolve_app_target',
        payload: target,
      })
      expect(resolved).toEqual(nextResolvedTarget)
    }
  })

  itEngine('getAppState sends {app} target and returns the daemon result', async () => {
    const exec = await loadExecutor()
    const daemonResult = {
      pid: 1106,
      appName: 'Finder',
      bundleId: 'com.apple.finder',
      windowTitle: 'Downloads',
      elementCount: 5,
      truncated: false,
      durationMs: 12,
      axText: 'App=com.apple.finder (pid 1106)\nWindow: "Downloads", App: Finder.',
      screenshot: { base64: 'AAAA', width: 100, height: 80 },
    }
    nextResult = daemonResult
    const out = await exec.engine!.getAppState({ app: 'Finder' })
    expect(lastCall()).toEqual({ command: 'get_app_state', payload: { app: 'Finder' } })
    expect(out).toEqual(daemonResult)
  })

  itEngine('getAppState maps disableDiff to the daemon payload', async () => {
    const exec = await loadExecutor()
    nextResult = { pid: 1, elementCount: 0, truncated: false, durationMs: 0, axText: '' }
    await exec.engine!.getAppState({ app: 'Finder' }, { disableDiff: true })
    expect(lastCall()).toEqual({
      command: 'get_app_state',
      payload: { app: 'Finder', disableDiff: true },
    })
  })

  itEngine('getAppState target precedence: pid wins over bundleId/app', async () => {
    const exec = await loadExecutor()
    nextResult = { pid: 1, elementCount: 0, truncated: false, durationMs: 0, axText: '' }
    await exec.engine!.getAppState({ pid: 42, bundleId: 'x', app: 'y' })
    expect(lastCall().payload).toEqual({ pid: 42 })
  })

  itEngine('forwards the resolved process lifetime with canonical PID commands', async () => {
    const exec = await loadExecutor()
    const identity = {
      pid: 4321,
      bundleId: 'com.apple.TextEdit',
      executablePath: '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit',
      launchTime: 12345.5,
    }
    nextResult = { pid: 4321, elementCount: 0, truncated: false, durationMs: 0, axText: '' }
    await exec.engine!.getAppState({
      pid: 4321,
      expectedProcessIdentity: identity,
    })
    expect(lastCall()).toMatchObject({
      command: 'get_app_state',
      payload: { pid: 4321, expectedProcessIdentity: identity },
    })

    await exec.engine!.pressKey({
      target: { pid: 4321, expectedProcessIdentity: identity },
      key: 'super+s',
      systemKeyCombos: false,
    })
    expect(lastCall()).toMatchObject({
      command: 'press_key',
      payload: { pid: 4321, expectedProcessIdentity: identity },
    })
  })

  itEngine('getAppState empty target → no keys (frontmost)', async () => {
    const exec = await loadExecutor()
    nextResult = { pid: 1, elementCount: 0, truncated: false, durationMs: 0, axText: '' }
    await exec.engine!.getAppState({})
    expect(lastCall().payload).toEqual({})
  })

  itEngine('click preserves the opaque snapshot handle in the daemon payload', async () => {
    const exec = await loadExecutor()
    await exec.engine!.click({
      target: { bundleId: 'com.apple.finder' },
      index: 'g17:4',
      clickCount: 2,
      button: 'right',
    })
    expect(lastCall().command).toBe('click')
    expect(lastCall().payload).toMatchObject({
      bundleId: 'com.apple.finder',
      index: 'g17:4',
      click_count: 2,
      button: 'right',
    })
  })

  itEngine('click by coordinate sends x/y (no index)', async () => {
    const exec = await loadExecutor()
    await exec.engine!.click({ target: {}, x: 10, y: 20 })
    expect(lastCall().payload).toMatchObject({ x: 10, y: 20 })
    expect(lastCall().payload.index).toBeUndefined()
  })

  itEngine('setValue sends handle + value and returns {before,after}', async () => {
    const exec = await loadExecutor()
    nextResult = { before: 'old', after: 'new' }
    const out = await exec.engine!.setValue({ target: { app: 'TextEdit' }, index: 'g18:7', value: 'new' })
    expect(lastCall()).toEqual({
      command: 'set_value',
      payload: { app: 'TextEdit', index: 'g18:7', value: 'new' },
    })
    expect(out).toEqual({ before: 'old', after: 'new' })
  })

  itEngine('performSecondaryAction sends index + action (pretty name)', async () => {
    const exec = await loadExecutor()
    await exec.engine!.performSecondaryAction({ target: {}, index: 'g19:0', action: 'Raise' })
    expect(lastCall()).toEqual({
      command: 'perform_secondary_action',
      payload: { index: 'g19:0', action: 'Raise' },
    })
  })

  itEngine('scroll sends direction + pages + optional index', async () => {
    const exec = await loadExecutor()
    await exec.engine!.scroll({ target: {}, index: 'g20:2', direction: 'down', pages: 3 })
    expect(lastCall().command).toBe('scroll')
    expect(lastCall().payload).toMatchObject({ index: 'g20:2', direction: 'down', pages: 3 })
  })

  itEngine('drag sends nested from/to + button', async () => {
    const exec = await loadExecutor()
    await exec.engine!.drag({
      target: {},
      from: { x: 1, y: 2 },
      to: { x: 3, y: 4 },
      button: 'left',
    })
    expect(lastCall()).toEqual({
      command: 'drag',
      payload: { from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, button: 'left' },
    })
  })

  test('pressKey sends the explicit system-shortcut grant bit without a platform-gated executor', async () => {
    const { createCodexEngine } = await import('./executor.js')
    const engine = createCodexEngine()
    await engine.pressKey({
      target: { app: 'Finder' },
      key: 'super+c',
      systemKeyCombos: false,
    })
    expect(lastCall()).toEqual({
      command: 'press_key',
      payload: { app: 'Finder', key: 'super+c', systemKeyCombos: false },
    })
  })

  itEngine('typeText sends text', async () => {
    const exec = await loadExecutor()
    await exec.engine!.typeText({ target: {}, text: 'hello' })
    expect(lastCall()).toEqual({ command: 'type_text', payload: { text: 'hello' } })
  })

  itEngine('paste sends explicit content format', async () => {
    const exec = await loadExecutor()
    await exec.engine!.paste({ target: { app: 'NeteaseMusic' }, text: '喜欢你', format: 'text' })
    expect(lastCall()).toEqual({
      command: 'paste',
      payload: { app: 'NeteaseMusic', text: '喜欢你', format: 'text' },
    })
  })

  itEngine('selectText sends text range parameters', async () => {
    const exec = await loadExecutor()
    await exec.engine!.selectText({
      target: { app: 'TextEdit' },
      index: 'g21:4',
      text: 'brown',
      prefix: 'quick ',
      suffix: ' fox',
      selection: 'text',
    })
    expect(lastCall()).toEqual({
      command: 'select_text',
      payload: {
        app: 'TextEdit',
        index: 'g21:4',
        text: 'brown',
        prefix: 'quick ',
        suffix: ' fox',
        selection: 'text',
      },
    })
  })

  itEngine('listApps formats the daemon AppRef[] into the text block', async () => {
    const exec = await loadExecutor()
    nextResult = [
      { bundleId: 'com.apple.finder', displayName: 'Finder' },
      { bundleId: 'com.apple.Safari', displayName: 'Safari' },
    ]
    const text = await exec.engine!.listApps()
    expect(lastCall().command).toBe('list_apps')
    expect(text).toBe('Finder — com.apple.finder\nSafari — com.apple.Safari')
  })

  itEngine('listApps on an empty daemon list returns a friendly message', async () => {
    const exec = await loadExecutor()
    nextResult = []
    const text = await exec.engine!.listApps()
    expect(text).toBe('No running applications are available to control.')
  })

  itEngine('preserves native inventory metadata without guessing running state', async () => {
    const exec = await loadExecutor()
    nextResult = [
      { id: 'dev.test.Editor', displayName: 'Editor', isRunning: false, lastUsedDate: '2026-09-09T01:00:00Z', useCount: 4 },
      { id: 'dev.test.Unknown' },
    ]
    expect(await exec.engine!.listAppsInfo!()).toEqual(nextResult)
    expect(calls).toEqual([{ command: 'list_apps', payload: {} }])
  })

  itEngine('accepts the previous helper inventory while upgrading the host', async () => {
    const exec = await loadExecutor()
    nextResult = [{ bundleId: 'com.apple.finder', displayName: 'Finder' }]
    expect(await exec.engine!.listAppsInfo!()).toEqual([
      { id: 'com.apple.finder', displayName: 'Finder', isRunning: true },
    ])
  })
})

describe('Windows virtual cursor motion', () => {
  test('the mouse-animation gate reaches every coordinate action', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return
    const { createCliExecutor } = await import('./executor.js')
    const exec = createCliExecutor({
      getMouseAnimationEnabled: () => true,
      getHideBeforeActionEnabled: () => false,
    })

    await exec.click(10, 20, 'left', 1, [])
    await exec.moveMouse(30, 40)
    await exec.scroll(50, 60, 0, -1)
    await exec.drag({ x: 70, y: 80 }, { x: 90, y: 100 })

    expect(calls.slice(-4)).toEqual([
      { command: 'click', payload: { x: 10, y: 20, button: 'left', count: 1, modifiers: [], animate: true } },
      { command: 'move_mouse', payload: { x: 30, y: 40, animate: true } },
      { command: 'scroll', payload: { x: 50, y: 60, deltaX: 0, deltaY: -1, animate: true } },
      { command: 'drag', payload: { from: { x: 70, y: 80 }, to: { x: 90, y: 100 }, animate: true } },
    ])
  })
})

describe('handleToolCall ↔ engine end-to-end (tool face → daemon payload)', () => {
  beforeEach(() => {
    calls.length = 0
    nextResult = true
    nextResolvedTarget = {
      pid: 1106,
      bundleId: 'com.apple.finder',
      displayName: 'Finder',
      path: '/System/Library/CoreServices/Finder.app',
      executablePath: '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder',
      launchTime: 2106,
    }
  })
  afterEach(() => {
    calls.length = 0
  })

  const itEngine = process.platform === 'darwin' ? test : test.skip

  async function makeAdapter() {
    const exec = await loadExecutor()
    return {
      serverName: 'computer-use',
      logger: {
        silly() {},
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
      executor: exec,
      ensureOsPermissions: async () => ({ granted: true as const }),
      isDisabled: () => false,
      getSubGates: () => ({}) as never,
      getAutoUnhideEnabled: () => true,
      cropRawPatch: () => null,
    } as unknown as import('../../vendor/computer-use-mcp/types.js').ComputerUseHostAdapter
  }

  function authorizedOverrides(
    extra: Record<string, unknown> = {},
  ): import('../../vendor/computer-use-mcp/types.js').ComputerUseOverrides {
    return {
      allowedApps: [{
        bundleId: 'com.apple.finder',
        displayName: 'Finder',
        grantedAt: 1,
      }],
      grantFlags: {
        clipboardRead: false,
        clipboardWrite: false,
        systemKeyCombos: false,
      },
      coordinateMode: 'pixels',
      userDeniedBundleIds: [],
      ...extra,
    } as import('../../vendor/computer-use-mcp/types.js').ComputerUseOverrides
  }

  itEngine('get_app_state through dispatch frames the envelope + image block', async () => {
    const { handleToolCall } = await import('../../vendor/computer-use-mcp/index.js')
    const adapter = await makeAdapter()
    nextResult = {
      pid: 1106,
      appName: 'Finder',
      bundleId: 'com.apple.finder',
      elementCount: 1,
      truncated: false,
      durationMs: 3,
      axText: 'App=com.apple.finder (pid 1106)\nWindow: "x", App: Finder.\n\t0 standard window x',
      screenshot: { base64: 'PNGB64', width: 10, height: 10 },
    }
    const res = await handleToolCall(
      adapter,
      'get_app_state',
      { app: 'Finder' },
      authorizedOverrides(),
    )
    expect(res.isError).toBeFalsy()
    // Engine reached the daemon with the resolved {app} payload.
    expect(calls.some(c => c.command === 'get_app_state')).toBe(true)
    // Text block carries the version banner + <app_state> wrapping the axText.
    const textBlock = res.content.find(b => b.type === 'text') as { text: string } | undefined
    expect(textBlock?.text).toContain('Computer Use state (CUA App Version:')
    expect(textBlock?.text).toContain('<app_state>')
    expect(textBlock?.text).toContain('App=com.apple.finder (pid 1106)')
    // Screenshot becomes a second image content block.
    const imageBlock = res.content.find(b => b.type === 'image') as
      | { data: string; mimeType: string }
      | undefined
    expect(imageBlock?.data).toBe('PNGB64')
    expect(imageBlock?.mimeType).toBe('image/png')
  })

  itEngine('click through dispatch hits the daemon once and returns a refresh receipt', async () => {
    const { handleToolCall } = await import('../../vendor/computer-use-mcp/index.js')
    const adapter = await makeAdapter()
    nextResult = true
    const res = await handleToolCall(
      adapter,
      'click',
      { app: 'Finder', element_index: 'g17:4', mouse_button: 'left' },
      authorizedOverrides(),
    )
    expect(res.isError).toBeFalsy()
    expect(calls.map(c => c.command)).toEqual(['resolve_app_target', 'click'])
    expect(calls[1].payload).toMatchObject({ pid: 1106, index: 'g17:4', button: 'left' })
    const textBlock = res.content.find(b => b.type === 'text') as { text: string } | undefined
    expect(textBlock?.text).toBe(
      'Action completed. Call `get_app_state` to fetch the updated UI state.',
    )
    expect(res.content.some(block => block.type === 'image')).toBe(false)
  })

  itEngine('ordinary press_key sends systemKeyCombos=false through dispatch', async () => {
    const { handleToolCall } = await import('../../vendor/computer-use-mcp/index.js')
    const adapter = await makeAdapter()
    const res = await handleToolCall(
      adapter,
      'press_key',
      { app: 'Finder', key: 'super+c' },
      authorizedOverrides({
        grantFlags: {
          clipboardRead: false,
          clipboardWrite: false,
          systemKeyCombos: false,
        },
      }),
    )

    expect(res.isError).toBeFalsy()
    expect(lastCall()).toMatchObject({
      command: 'press_key',
      payload: { pid: 1106, key: 'super+c', systemKeyCombos: false },
    })
  })

  itEngine('granted dangerous press_key sends systemKeyCombos=true through dispatch', async () => {
    const { handleToolCall } = await import('../../vendor/computer-use-mcp/index.js')
    const adapter = await makeAdapter()
    const res = await handleToolCall(
      adapter,
      'press_key',
      { app: 'Finder', key: 'cmd+q' },
      authorizedOverrides({
        grantFlags: {
          clipboardRead: false,
          clipboardWrite: false,
          systemKeyCombos: true,
        },
      }),
    )

    expect(res.isError).toBeFalsy()
    expect(lastCall()).toMatchObject({
      command: 'press_key',
      payload: { pid: 1106, key: 'cmd+q', systemKeyCombos: true },
    })
  })

  itEngine('list_apps through dispatch returns the formatted text', async () => {
    const { handleToolCall } = await import('../../vendor/computer-use-mcp/index.js')
    const adapter = await makeAdapter()
    nextResult = [{ bundleId: 'com.apple.finder', displayName: 'Finder' }]
    const res = await handleToolCall(adapter, 'list_apps', {}, {})
    expect(res.isError).toBeFalsy()
    const textBlock = res.content.find(b => b.type === 'text') as { text: string } | undefined
    expect(textBlock?.text).toBe('Finder — com.apple.finder')
  })

  itEngine('a daemon staleness error surfaces verbatim as a tool error', async () => {
    const { handleToolCall } = await import('../../vendor/computer-use-mcp/index.js')
    const adapter = await makeAdapter()
    // Make the engine throw the daemon's §6 staleness message on the click.
    mock.module('./helperBridge.js', () => ({
      callHelper: async (command: string) => {
        if (command === 'resolve_app_target') {
          return nextResolvedTarget
        }
        throw new Error(
          "The user changed 'Finder'. Re-query the latest state with get_app_state before sending more actions.",
        )
      },
      __resetHelperBridgeState: () => {},
    }))
    const exec = await import('./executor.js').then(m =>
      m.createCliExecutor({
        getMouseAnimationEnabled: () => false,
        getHideBeforeActionEnabled: () => false,
      }),
    )
    ;(adapter as { executor: unknown }).executor = exec
    const res = await handleToolCall(
      adapter,
      'click',
      { app: 'Finder', element_index: 'g17:4' },
      authorizedOverrides(),
    )
    expect(res.isError).toBe(true)
    const textBlock = res.content.find(b => b.type === 'text') as { text: string } | undefined
    expect(textBlock?.text).toContain("The user changed 'Finder'")
    // Restore the capturing mock for any later tests.
    mock.module('./helperBridge.js', () => ({
      callHelper: async (command: string, payload: Record<string, unknown> = {}) => {
        calls.push({ command, payload })
        return command === 'resolve_app_target' ? nextResolvedTarget : nextResult
      },
      __resetHelperBridgeState: () => {},
    }))
  })
})
