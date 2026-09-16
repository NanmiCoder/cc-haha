import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { diagnosticsService } from '../services/diagnosticsService.js'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
let configDir: string | null = null
let computerUseApi: typeof import('../api/computer-use.js') | null = null

async function importComputerUseApi() {
  if (!computerUseApi) throw new Error('Computer Use API module was not initialized')
  return computerUseApi
}

function makeRequest(method: string, body?: unknown): Request {
  return new Request('http://localhost/api/computer-use/authorized-apps', {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function callAuthorizedApps(method: string, body?: unknown): Promise<Response> {
  const { handleComputerUseApi } = await importComputerUseApi()
  return handleComputerUseApi(
    makeRequest(method, body),
    new URL('http://localhost/api/computer-use/authorized-apps'),
    ['api', 'computer-use', 'authorized-apps'],
  )
}

async function callComputerUseAction(
  action: string,
  method: string,
  body: string,
): Promise<Response> {
  const { handleComputerUseApi } = await importComputerUseApi()
  return handleComputerUseApi(
    new Request(`http://localhost/api/computer-use/${action}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body,
    }),
    new URL(`http://localhost/api/computer-use/${action}`),
    ['api', 'computer-use', action],
  )
}

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'cc-haha-computer-use-api-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  computerUseApi = await import('../api/computer-use.js')
})

beforeEach(async () => {
  if (!configDir) throw new Error('configDir was not initialized')
  process.env.CLAUDE_CONFIG_DIR = configDir
  await rm(join(configDir, 'cc-haha'), { recursive: true, force: true })
  await rm(join(configDir, '.runtime'), { recursive: true, force: true })
})

afterAll(async () => {
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
  }

  if (configDir) {
    await rm(configDir, { recursive: true, force: true })
    configDir = null
  }
})

describe('Computer Use API authorized app config', () => {
  it('defaults Computer Use off until the risk confirmation is accepted', async () => {
    const res = await callAuthorizedApps('GET')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      enabled: false,
      authorizedApps: [],
      grantFlags: {
        clipboardRead: true,
        clipboardWrite: true,
        systemKeyCombos: true,
      },
    })
  })

  it('persists the Computer Use enabled flag independently', async () => {
    const putRes = await callAuthorizedApps('PUT', { enabled: false })
    expect(putRes.status).toBe(200)

    const getRes = await callAuthorizedApps('GET')
    expect(await getRes.json()).toMatchObject({ enabled: false })

    const raw = await readFile(
      join(configDir!, 'cc-haha', 'computer-use-config.json'),
      'utf8',
    )
    expect(JSON.parse(raw)).toMatchObject({ enabled: false })
  })

  it('persists and normalizes a custom Python interpreter path', async () => {
    const pythonPath = '  C:\\Users\\me\\miniconda3\\envs\\cu\\python.exe  '
    const putRes = await callAuthorizedApps('PUT', { pythonPath })
    expect(putRes.status).toBe(200)

    const getRes = await callAuthorizedApps('GET')
    expect(await getRes.json()).toMatchObject({
      pythonPath: 'C:\\Users\\me\\miniconda3\\envs\\cu\\python.exe',
    })

    const resetRes = await callAuthorizedApps('PUT', { pythonPath: '' })
    expect(resetRes.status).toBe(200)

    const resetGetRes = await callAuthorizedApps('GET')
    expect(await resetGetRes.json()).toMatchObject({ pythonPath: null })
  })

  it('preserves asymmetric clipboard permissions', async () => {
    const putRes = await callAuthorizedApps('PUT', {
      grantFlags: {
        clipboardRead: true,
        clipboardWrite: false,
        systemKeyCombos: true,
      },
    })
    expect(putRes.status).toBe(200)

    const getRes = await callAuthorizedApps('GET')
    expect(await getRes.json()).toMatchObject({
      grantFlags: {
        clipboardRead: true,
        clipboardWrite: false,
        systemKeyCombos: true,
      },
    })
  })

  it('rejects malformed config patches without writing them', async () => {
    const invalidBodies = [
      { enabled: 'false' },
      { grantFlags: { clipboardRead: 'yes' } },
      { authorizedApps: [{ bundleId: '', displayName: 'Preview' }] },
      {
        authorizedApps: [
          {
            bundleId: 'com.apple.Preview',
            displayName: 'Preview',
            authorizedAt: 42,
          },
        ],
      },
      { pythonPath: 42 },
      { enabled: false, unexpected: true },
    ]

    for (const body of invalidBodies) {
      const response = await callAuthorizedApps('PUT', body)
      expect(response.status).toBe(400)
    }

    await expect(
      readFile(join(configDir!, 'cc-haha', 'computer-use-config.json'), 'utf8'),
    ).rejects.toThrow()
  })

  it('fails closed on a corrupt stored config and refuses to overwrite it', async () => {
    const configPath = join(configDir!, 'cc-haha', 'computer-use-config.json')
    await mkdir(join(configDir!, 'cc-haha'), { recursive: true })
    await writeFile(configPath, '{"enabled":"yes"}', 'utf8')

    const getRes = await callAuthorizedApps('GET')
    expect(getRes.status).toBe(500)
    const getBody = await getRes.json() as any
    expect(getBody.error).toBe('COMPUTER_USE_CONFIG_INVALID')
    expect(getBody.configPath).toBe(configPath)
    expect(getBody.recoveryHint).toContain('删除或修复')

    const putRes = await callAuthorizedApps('PUT', { enabled: false })
    expect(putRes.status).toBe(409)
    const putBody = await putRes.json() as any
    expect(putBody.error).toBe('COMPUTER_USE_CONFIG_INVALID')
    expect(putBody.configPath).toBe(configPath)
    expect(putBody.recoveryHint).toContain('删除或修复')
    expect(await readFile(configPath, 'utf8')).toBe('{"enabled":"yes"}')
  })

  it('preserves old and future config fields while changing a known field', async () => {
    const configPath = join(configDir!, 'cc-haha', 'computer-use-config.json')
    await mkdir(join(configDir!, 'cc-haha'), { recursive: true })
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      authorizedApps: [
        {
          bundleId: 'com.google.Chrome',
          displayName: 'Google Chrome',
          authorizedAt: 'legacy timestamp',
          tier: 'full',
          futureAppField: { keep: true },
        },
      ],
      grantFlags: {
        clipboardRead: true,
        clipboardWrite: false,
        systemKeyCombos: true,
        futureGrantFlag: 'keep',
      },
      pythonPath: null,
      futureTopLevel: { keep: true },
    }), 'utf8')

    const putRes = await callAuthorizedApps('PUT', { enabled: false })
    expect(putRes.status).toBe(200)

    const saved = JSON.parse(await readFile(configPath, 'utf8'))
    expect(saved).toMatchObject({
      enabled: false,
      authorizedApps: [
        {
          bundleId: 'com.google.Chrome',
          authorizedAt: 'legacy timestamp',
          tier: 'full',
          futureAppField: { keep: true },
        },
      ],
      grantFlags: {
        clipboardRead: true,
        clipboardWrite: false,
        systemKeyCombos: true,
        futureGrantFlag: 'keep',
      },
      futureTopLevel: { keep: true },
    })
  })

  it('rejects malformed open-settings JSON without performing a fallback action', async () => {
    const malformed = await callComputerUseAction('open-settings', 'POST', '{')
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({
      error: 'INVALID_OPEN_SETTINGS_REQUEST',
    })

    for (const body of ['null', '[]']) {
      const response = await callComputerUseAction('open-settings', 'POST', body)
      expect(response.status).toBe(400)
    }
  })
})

describe('Computer Use platform capability', () => {
  it('builds native macOS status through the real capability transition', async () => {
    const { checkStatus } = await importComputerUseApi()
    const calls: string[] = []

    const status = await checkStatus({
      platform: 'darwin',
      arch: 'x64',
      detectMacosProductVersion: async () => {
        calls.push('version')
        return '14.4.1'
      },
      isMacosRuntimeSupported: (platform) => {
        calls.push(`runtime:${platform}`)
        return true
      },
      isCuHelperAvailable: () => {
        calls.push('helper')
        return true
      },
      checkPermissions: async () => {
        calls.push('permissions')
        return { accessibility: true, screenRecording: false, error: null }
      },
    })

    expect(calls).toEqual(['version', 'runtime:darwin', 'helper', 'permissions'])
    expect(status).toEqual({
      platform: 'darwin',
      supported: true,
      engine: 'macos-native',
      systemVersion: '14.4.1',
      arch: 'x64',
      cuHelper: {
        available: true,
        supported: true,
        minimumMacosVersion: '14.4',
        reason: null,
      },
      python: { installed: false, version: null, path: null, source: null, error: null },
      venv: { created: false, path: expect.any(String) },
      dependencies: { installed: false, requirementsFound: false },
      permissions: { accessibility: true, screenRecording: false, error: null },
    })
  })

  it('does not probe or launch the helper below the macOS system floor', async () => {
    const { checkStatus } = await importComputerUseApi()
    let helperCalls = 0
    let permissionCalls = 0

    const status = await checkStatus({
      platform: 'darwin',
      arch: 'arm64',
      detectMacosProductVersion: async () => '14.3.9',
      isMacosRuntimeSupported: () => true,
      isCuHelperAvailable: () => {
        helperCalls += 1
        return true
      },
      checkPermissions: async () => {
        permissionCalls += 1
        return { accessibility: true, screenRecording: true, error: null }
      },
    })

    expect(helperCalls).toBe(0)
    expect(permissionCalls).toBe(0)
    expect(status).toMatchObject({
      supported: false,
      engine: 'unsupported',
      systemVersion: '14.3.9',
      arch: 'arm64',
      cuHelper: { available: false, supported: false, reason: 'os_too_old' },
      permissions: { accessibility: null, screenRecording: null, error: null },
    })
  })

  it('keeps eligible macOS on the native engine when the helper is missing', async () => {
    const { resolveComputerUseCapability } = await importComputerUseApi()

    expect(resolveComputerUseCapability('darwin', '14.4', false)).toEqual({
      supported: true,
      engine: 'macos-native',
      cuHelper: {
        available: false,
        supported: true,
        minimumMacosVersion: '14.4',
        reason: 'helper_missing',
      },
    })
    expect(resolveComputerUseCapability('darwin', '15.0', true).engine)
      .toBe('macos-native')
  })

  it('fails closed below the native system floor without string comparison bugs', async () => {
    const { isVersionAtLeast, resolveComputerUseCapability } = await importComputerUseApi()

    expect(isVersionAtLeast('14.10', '14.4')).toBe(true)
    expect(isVersionAtLeast('14.3.9', '14.4')).toBe(false)
    expect(resolveComputerUseCapability('darwin', '14.3.9', true)).toMatchObject({
      supported: false,
      engine: 'unsupported',
      cuHelper: { available: false, reason: 'os_too_old' },
    })
    expect(resolveComputerUseCapability('darwin', null, true)).toMatchObject({
      supported: false,
      engine: 'unsupported',
      cuHelper: { available: false, reason: 'system_version_unknown' },
    })
    expect(resolveComputerUseCapability('darwin', null, true, true)).toMatchObject({
      supported: true,
      engine: 'macos-native',
      cuHelper: { available: true, reason: null },
    })
  })

  it('routes Windows to compatibility and rejects unsupported platforms', async () => {
    const { resolveComputerUseCapability } = await importComputerUseApi()

    expect(resolveComputerUseCapability('win32', null, false).engine)
      .toBe('windows-compat')
    expect(resolveComputerUseCapability('linux', null, false)).toMatchObject({
      supported: false,
      engine: 'unsupported',
    })
  })
})

describe('runPipInstallWithFallback', () => {
  it('rejects setup on unsupported platforms before writing runtime files', async () => {
    const { getUnsupportedComputerUsePlatformStep } = await importComputerUseApi()

    expect(getUnsupportedComputerUsePlatformStep('linux')).toEqual({
      name: 'platform',
      ok: false,
      message: 'Computer Use does not support platform: linux',
    })
    expect(getUnsupportedComputerUsePlatformStep('darwin')).toBeNull()
    expect(getUnsupportedComputerUsePlatformStep('win32')).toBeNull()
  })

  it('builds a clear unsupported Python version step for setup', async () => {
    const { getUnsupportedPythonVersionStep } = await importComputerUseApi()

    expect(getUnsupportedPythonVersionStep('3.8.18')).toEqual({
      name: 'python_version',
      ok: false,
      message: 'Computer Use 需要 Python >= 3.9，当前版本为 3.8.18',
    })
    expect(getUnsupportedPythonVersionStep('3.9.19')).toBeNull()
  })

  it('installs setup dependencies by upgrading pip before requirements', async () => {
    const { installSetupDependencies } = await importComputerUseApi()
    const calls: string[] = []

    const result = await installSetupDependencies(
      'python',
      '/tmp/requirements.txt',
      async (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`)
        return { ok: true, stdout: args.includes('-r') ? 'deps' : 'pip', stderr: '', code: 0 }
      },
    )

    expect(result.stdout).toBe('deps')
    expect(calls).toEqual([
      'python -m pip install --upgrade pip',
      'python -m pip install -r /tmp/requirements.txt',
    ])
  })

  it('tries the mirror first and falls back to the default PyPI index', async () => {
    const { runPipInstallWithFallback } = await importComputerUseApi()
    const calls: string[] = []
    const result = await runPipInstallWithFallback(
      'python',
      ['-m', 'pip', 'install', '-r', 'requirements.txt'],
      async (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`)
        if (args.includes('-i')) {
          return { ok: false, stdout: '', stderr: 'mirror unavailable', code: 1 }
        }
        return { ok: true, stdout: 'installed', stderr: '', code: 0 }
      },
    )

    expect(result.ok).toBe(true)
    expect(result.stdout).toBe('installed')
    expect(calls).toEqual([
      'python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple/ --trusted-host pypi.tuna.tsinghua.edu.cn',
      'python -m pip install -r requirements.txt',
    ])
  })

  it('returns the first failure when every pip index attempt fails', async () => {
    const { runPipInstallWithFallback } = await importComputerUseApi()
    const result = await runPipInstallWithFallback(
      'python',
      ['-m', 'pip', 'install', '-r', 'requirements.txt'],
      async (_cmd, args) => ({
        ok: false,
        stdout: '',
        stderr: args.includes('-i') ? 'mirror failed' : 'default failed',
        code: args.includes('-i') ? 1 : 2,
      }),
    )

    expect(result).toEqual({ ok: false, stdout: '', stderr: 'mirror failed', code: 1 })
  })

  it('reports OS settings launch failures instead of returning success', async () => {
    const { openComputerUseSettings } = await importComputerUseApi()
    const calls: string[] = []

    const failed = await openComputerUseSettings(
      'darwin',
      'Privacy_Accessibility',
      async (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`)
        return { ok: false, stdout: '', stderr: 'open failed', code: 1 }
      },
    )
    expect(failed).toEqual({ ok: false, message: 'open failed' })
    expect(calls).toEqual([
      'open x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    ])

    expect(
      await openComputerUseSettings(
        'linux',
        'Privacy_ScreenCapture',
        async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
      ),
    ).toEqual({ ok: false, message: 'Unsupported platform' })
  })
})

describe('retired per-app authorization endpoint', () => {
  it('cannot emit a runtime approval request', async () => {
    const response = await callComputerUseAction(
      'request-access',
      'POST',
      JSON.stringify({
        sessionId: 'session-1',
        request: { requestId: 'request-1', apps: [] },
      }),
    )

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toMatchObject({
      error: 'APP_AUTHORIZATION_REMOVED',
    })
  })
})

describe('parsePermissionSnapshot', () => {
  it('extracts accessibility / screenRecording from the cu-helper envelope', async () => {
    const { parsePermissionSnapshot } = await importComputerUseApi()

    expect(
      parsePermissionSnapshot('{"ok":true,"result":{"accessibility":true,"screenRecording":false}}'),
    ).toEqual({ accessibility: true, screenRecording: false })
  })

  it('scans backwards past incidental log lines to the last JSON envelope', async () => {
    const { parsePermissionSnapshot } = await importComputerUseApi()

    const stdout = [
      'some startup chatter',
      '{"ok":true,"result":{"accessibility":false,"screenRecording":false}}',
      '{"ok":true,"result":{"accessibility":true,"screenRecording":true}}',
    ].join('\n')

    expect(parsePermissionSnapshot(stdout)).toEqual({
      accessibility: true,
      screenRecording: true,
    })
  })

  it('returns nulls when no parseable envelope is present', async () => {
    const { parsePermissionSnapshot } = await importComputerUseApi()

    expect(parsePermissionSnapshot('not json at all')).toEqual({
      accessibility: null,
      screenRecording: null,
    })
    expect(parsePermissionSnapshot('')).toEqual({
      accessibility: null,
      screenRecording: null,
    })
  })

  it('coerces a missing field in the result to null', async () => {
    const { parsePermissionSnapshot } = await importComputerUseApi()

    expect(parsePermissionSnapshot('{"ok":true,"result":{"accessibility":true}}')).toEqual({
      accessibility: true,
      screenRecording: null,
    })
  })
})

/**
 * The icon endpoint rasterises a file and returns its bytes, so what it accepts
 * as input is a security property: it takes a bundle id and resolves the path
 * itself, and there is deliberately no parameter that names a file.
 */
describe('app icon endpoint input', () => {
  async function requestIcon(query: string): Promise<Response> {
    const { handleComputerUseApi, __resetInstalledAppPathCacheForTests } =
      await importComputerUseApi()
    __resetInstalledAppPathCacheForTests()
    const url = new URL(`http://localhost/api/computer-use/app-icon${query}`)
    return handleComputerUseApi(new Request(url, { method: 'GET' }), url, [
      'api',
      'computer-use',
      'app-icon',
    ])
  }

  it('rejects a request that names no bundle', async () => {
    const response = await requestIcon('')
    // 404 off darwin, where the endpoint does not exist at all.
    expect([400, 404]).toContain(response.status)
  })

  it('refuses paths dressed up as bundle ids', async () => {
    // None of these resolve through the installed-app list, so none of them can
    // reach the filesystem — the point is that a path is not a way in.
    for (const attempt of [
      '/Applications/Safari.app',
      '../../../etc/passwd',
      '/etc/passwd',
      '/System/Library/CoreServices/Finder.app/Contents/Resources/Finder.icns',
    ]) {
      const response = await requestIcon(
        `?bundleId=${encodeURIComponent(attempt)}`,
      )
      expect(response.status).toBe(404)
      expect(response.headers.get('Content-Type')).not.toBe('image/png')
    }
  })

  it('reports an unknown bundle id as missing rather than erroring', async () => {
    const response = await requestIcon('?bundleId=com.example.not.installed')
    expect(response.status).toBe(404)
  })

  it('enumerates applications once for a burst of concurrent lookups', async () => {
    // Opening the picker fires one icon request per visible row at the same
    // moment. A check-then-fill cache is still cold for all of them, so without
    // in-flight sharing each row would walk every application root — hundreds
    // of `plutil` spawns to answer one screen.
    const { resolveInstalledAppPath, __resetInstalledAppPathCacheForTests } =
      await importComputerUseApi()
    __resetInstalledAppPathCacheForTests()

    let scans = 0
    const lister = async () => {
      scans += 1
      await new Promise(resolve => setTimeout(resolve, 5))
      return [{ bundleId: 'com.example.App', path: '/Applications/App.app' }]
    }

    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        resolveInstalledAppPath('com.example.App', lister),
      ),
    )

    expect(scans).toBe(1)
    expect(new Set(results)).toEqual(new Set(['/Applications/App.app']))

    // The warm cache serves later lookups without scanning again.
    expect(await resolveInstalledAppPath('com.example.App', lister)).toBe(
      '/Applications/App.app',
    )
    expect(scans).toBe(1)

    __resetInstalledAppPathCacheForTests()
  })
})

describe('native permission card command result', () => {
  it('fails when the helper exits unsuccessfully or returns no snapshot', async () => {
    const { resolvePermissionCardCommandResult } = await importComputerUseApi()

    expect(resolvePermissionCardCommandResult({
      ok: false,
      stdout: '',
      stderr: 'loader rejected helper',
      code: 1,
    })).toEqual({
      ok: false,
      reason: 'loader rejected helper',
      accessibility: null,
      screenRecording: null,
    })
    expect(resolvePermissionCardCommandResult({
      ok: true,
      stdout: 'not-json',
      stderr: '',
      code: 0,
    })).toMatchObject({ ok: false, accessibility: null, screenRecording: null })
  })

  it('returns the final valid permission snapshot', async () => {
    const { resolvePermissionCardCommandResult } = await importComputerUseApi()

    expect(resolvePermissionCardCommandResult({
      ok: true,
      stdout: 'log\n{"ok":true,"result":{"accessibility":true,"screenRecording":false}}',
      stderr: '',
      code: 0,
    })).toEqual({ ok: true, accessibility: true, screenRecording: false })
  })
})

/**
 * Nulls render as a permanent "checking…" in the settings page, so a probe that
 * fails silently is indistinguishable from one still in flight. That happened:
 * the shipped sidecar got re-signed, the helper answered `unauthorized_client`,
 * and the only visible symptom was a spinner that never resolved.
 */
describe('checkCuHelperPermissions failure reporting', () => {
  it('records an error-level diagnostic when the helper probe throws', async () => {
    const { checkCuHelperPermissions } = await importComputerUseApi()
    const recorded: Array<Record<string, unknown>> = []
    const spy = spyOn(diagnosticsService, 'recordEvent').mockImplementation(
      async (input: unknown) => {
        recorded.push(input as Record<string, unknown>)
        return { written: true } as never
      },
    )

    try {
      const result = await checkCuHelperPermissions(async () => {
        throw new Error(
          'This helper command requires the signed Claude Code Haha desktop app.',
        )
      })

      expect(result).toEqual({
        accessibility: null,
        screenRecording: null,
        error: 'This helper command requires the signed Claude Code Haha desktop app.',
      })

      expect(recorded).toHaveLength(1)
      expect(recorded[0]).toMatchObject({
        type: 'computer_use_permission_probe_failed',
        // The user did nothing wrong and the check did not complete, which is
        // this project's definition of error rather than warn.
        severity: 'error',
        summary:
          'This helper command requires the signed Claude Code Haha desktop app.',
      })
    } finally {
      spy.mockRestore()
    }
  })

  it('stays silent on the success path', async () => {
    const { checkCuHelperPermissions } = await importComputerUseApi()
    const spy = spyOn(diagnosticsService, 'recordEvent').mockImplementation(
      async () => ({ written: true }) as never,
    )

    try {
      const result = await checkCuHelperPermissions(
        async () =>
          ({ accessibility: true, screenRecording: false }) as never,
      )

      expect(result).toEqual({ accessibility: true, screenRecording: false, error: null })
      // A granted-or-denied answer is a completed check, not a diagnostic event.
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
