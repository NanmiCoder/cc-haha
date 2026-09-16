import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import {
  buildCronCliArgs,
  buildCronTaskSpawnOptions,
  CronScheduler,
  resolveCronTaskTimeoutMs,
  resolveCronProjectRoot,
} from '../services/cronScheduler.js'
import { CronService } from '../services/cronService.js'
import { ProviderService } from '../services/providerService.js'
import { resetTerminalShellEnvironmentCacheForTests } from '../../utils/terminalShellEnvironment.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalPath = process.env.PATH
const originalClaudeCliPath = process.env.CLAUDE_CLI_PATH
const originalClaudeAppRoot = process.env.CLAUDE_APP_ROOT
const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL
const originalAnthropicModel = process.env.ANTHROPIC_MODEL
const originalClaudeCodeEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
const originalHome = process.env.HOME
const originalShell = process.env.SHELL
const originalZdotdir = process.env.ZDOTDIR
const originalDisableTerminalShellEnv = process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
const originalTaskTimeout = process.env.CC_HAHA_TASK_TIMEOUT_MS
const originalLocalAccessToken = process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
const originalSystemProxyUrl = process.env.CC_HAHA_SYSTEM_PROXY_URL
const originalHttpProxy = process.env.HTTP_PROXY
const originalHttpsProxy = process.env.HTTPS_PROXY
const originalLowerHttpProxy = process.env.http_proxy
const originalLowerHttpsProxy = process.env.https_proxy

const isWindows = process.platform === 'win32'
const unixOnly = isWindows ? it.skip : it

async function createTmpDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `claude-cron-launcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function cleanupTmpDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}

async function createSourceRoot(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'src', 'entrypoints'), { recursive: true })
  await fs.writeFile(path.join(root, 'preload.ts'), '', 'utf-8')
  await fs.writeFile(
    path.join(root, 'src', 'entrypoints', 'cli.tsx'),
    '',
    'utf-8',
  )
}

function restoreEnv(): void {
  if (originalConfigDir) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  if (originalPath) {
    process.env.PATH = originalPath
  } else {
    delete process.env.PATH
  }
  if (originalClaudeCliPath) {
    process.env.CLAUDE_CLI_PATH = originalClaudeCliPath
  } else {
    delete process.env.CLAUDE_CLI_PATH
  }
  if (originalClaudeAppRoot) {
    process.env.CLAUDE_APP_ROOT = originalClaudeAppRoot
  } else {
    delete process.env.CLAUDE_APP_ROOT
  }
  if (originalAnthropicBaseUrl) {
    process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl
  } else {
    delete process.env.ANTHROPIC_BASE_URL
  }
  if (originalAnthropicModel) {
    process.env.ANTHROPIC_MODEL = originalAnthropicModel
  } else {
    delete process.env.ANTHROPIC_MODEL
  }
  if (originalClaudeCodeEntrypoint) {
    process.env.CLAUDE_CODE_ENTRYPOINT = originalClaudeCodeEntrypoint
  } else {
    delete process.env.CLAUDE_CODE_ENTRYPOINT
  }
  if (originalHome) {
    process.env.HOME = originalHome
  } else {
    delete process.env.HOME
  }
  if (originalShell) {
    process.env.SHELL = originalShell
  } else {
    delete process.env.SHELL
  }
  if (originalZdotdir) {
    process.env.ZDOTDIR = originalZdotdir
  } else {
    delete process.env.ZDOTDIR
  }
  if (originalDisableTerminalShellEnv) {
    process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = originalDisableTerminalShellEnv
  } else {
    delete process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
  }
  if (originalTaskTimeout) {
    process.env.CC_HAHA_TASK_TIMEOUT_MS = originalTaskTimeout
  } else {
    delete process.env.CC_HAHA_TASK_TIMEOUT_MS
  }
  if (originalLocalAccessToken !== undefined) {
    process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = originalLocalAccessToken
  } else {
    delete process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
  }
  if (originalSystemProxyUrl !== undefined) {
    process.env.CC_HAHA_SYSTEM_PROXY_URL = originalSystemProxyUrl
  } else {
    delete process.env.CC_HAHA_SYSTEM_PROXY_URL
  }
  if (originalHttpProxy !== undefined) process.env.HTTP_PROXY = originalHttpProxy
  else delete process.env.HTTP_PROXY
  if (originalHttpsProxy !== undefined) process.env.HTTPS_PROXY = originalHttpsProxy
  else delete process.env.HTTPS_PROXY
  if (originalLowerHttpProxy !== undefined) process.env.http_proxy = originalLowerHttpProxy
  else delete process.env.http_proxy
  if (originalLowerHttpsProxy !== undefined) process.env.https_proxy = originalLowerHttpsProxy
  else delete process.env.https_proxy
  resetSettingsCache()
  resetTerminalShellEnvironmentCacheForTests()
}

describe('cron scheduler launcher resolution', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = path.join(tmpDir, 'config')
    process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
    resetSettingsCache()
    resetTerminalShellEnvironmentCacheForTests()
  })

  afterEach(async () => {
    restoreEnv()
    await cleanupTmpDir(tmpDir)
  })

  it('uses a configurable scheduled task timeout with the default unchanged', () => {
    expect(resolveCronTaskTimeoutMs({})).toBe(10 * 60 * 1000)
    expect(resolveCronTaskTimeoutMs({ CC_HAHA_TASK_TIMEOUT_MS: '1800000' })).toBe(1_800_000)
    expect(resolveCronTaskTimeoutMs({ CC_HAHA_TASK_TIMEOUT_MS: 'not-a-number' })).toBe(10 * 60 * 1000)
    expect(resolveCronTaskTimeoutMs({ CC_HAHA_TASK_TIMEOUT_MS: '0' })).toBe(10 * 60 * 1000)
  })

  unixOnly('executeTask arms the subprocess timeout from CC_HAHA_TASK_TIMEOUT_MS', async () => {
    const binDir = path.join(tmpDir, 'bin')
    const sidecarPath = path.join(tmpDir, 'claude-sidecar')
    const appRoot = path.join(tmpDir, 'app-root')
    await fs.mkdir(binDir, { recursive: true })
    await fs.mkdir(appRoot, { recursive: true })
    await fs.writeFile(
      sidecarPath,
      [
        '#!/bin/sh',
        '/bin/cat >/dev/null',
        'printf \'%s\\n\' \'{"type":"result","result":"timeout env ok"}\'',
        'exit 0',
        '',
      ].join('\n'),
      'utf-8',
    )
    await fs.chmod(sidecarPath, 0o755)

    const originalSetTimeout = globalThis.setTimeout
    const timeoutCalls: number[] = []
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      timeoutCalls.push(timeout ?? 0)
      return originalSetTimeout(handler, timeout, ...args)
    }) as typeof setTimeout

    process.env.PATH = binDir
    process.env.CLAUDE_CLI_PATH = sidecarPath
    process.env.CLAUDE_APP_ROOT = appRoot
    process.env.CC_HAHA_TASK_TIMEOUT_MS = '12345'

    try {
      const cronService = new CronService()
      const scheduler = new CronScheduler(cronService)
      const task = await cronService.createTask({
        cron: '* * * * *',
        prompt: 'cron timeout env test',
        name: 'Timeout Env Task',
        recurring: true,
        folderPath: tmpDir,
      })

      const run = await scheduler.executeTask(task)

      expect(run.status).toBe('completed')
      expect(timeoutCalls).toContain(12_345)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('uses the bundled sidecar launcher when one is configured', () => {
    const sidecarPath = path.join(tmpDir, 'claude-sidecar')
    const appRoot = path.join(tmpDir, 'app-root')

    const args = buildCronCliArgs(['--print'], {
      cliPath: sidecarPath,
      appRoot,
      execPath: path.join(tmpDir, 'bun'),
      cwd: path.join(tmpDir, 'missing-cwd'),
      moduleDir: path.join(tmpDir, 'missing-module'),
      env: {},
    })

    expect(args).toEqual([
      sidecarPath,
      'cli',
      '--app-root',
      appRoot,
      '--print',
    ])
  })

  it('builds hidden CLI spawn options for scheduled task subprocesses', () => {
    const env = { CLAUDECODE: '1' }

    expect(buildCronTaskSpawnOptions('/workspace/project', env)).toEqual({
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: '/workspace/project',
      env,
      windowsHide: true,
    })
  })

  it('prefers an explicit CC_HAHA_ROOT when it points at a source checkout', async () => {
    const sourceRoot = path.join(tmpDir, 'source')
    await createSourceRoot(sourceRoot)

    expect(
      resolveCronProjectRoot({
        cwd: path.join(tmpDir, 'other'),
        moduleDir: path.join(tmpDir, 'broken', 'src', 'server', 'services'),
        env: { CC_HAHA_ROOT: sourceRoot },
      }),
    ).toBe(sourceRoot)
  })

  it('falls back to the nearest source checkout from cwd before module dir', async () => {
    const sourceRoot = path.join(tmpDir, 'source')
    const nestedCwd = path.join(sourceRoot, 'nested', 'workdir')
    await createSourceRoot(sourceRoot)
    await fs.mkdir(nestedCwd, { recursive: true })

    expect(
      resolveCronProjectRoot({
        cwd: nestedCwd,
        moduleDir: path.join(tmpDir, 'wrong', 'src', 'server', 'services'),
        env: {},
      }),
    ).toBe(sourceRoot)
  })

  unixOnly('executeTask launches the configured desktop sidecar instead of source bun', async () => {
    const binDir = path.join(tmpDir, 'bin')
    const appRoot = path.join(tmpDir, 'app-root')
    const sidecarPath = path.join(tmpDir, 'claude-sidecar')
    const sidecarArgsPath = path.join(tmpDir, 'sidecar.args')
    const bunArgsPath = path.join(tmpDir, 'bun.args')

    await fs.mkdir(binDir, { recursive: true })
    await fs.mkdir(appRoot, { recursive: true })
    await fs.writeFile(
      path.join(binDir, 'bun'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > "${bunArgsPath}"`,
        'echo "error: Module not found \\"B:\\\\src\\\\entrypoints\\\\cli.tsx\\"" >&2',
        'exit 1',
        '',
      ].join('\n'),
      'utf-8',
    )
    await fs.chmod(path.join(binDir, 'bun'), 0o755)
    await fs.writeFile(
      sidecarPath,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > "${sidecarArgsPath}"`,
        '/bin/cat >/dev/null',
        'printf \'%s\\n\' \'{"type":"result","result":"sidecar ok"}\'',
        'exit 0',
        '',
      ].join('\n'),
      'utf-8',
    )
    await fs.chmod(sidecarPath, 0o755)

    process.env.PATH = binDir
    process.env.CLAUDE_CLI_PATH = sidecarPath
    process.env.CLAUDE_APP_ROOT = appRoot

    const cronService = new CronService()
    const scheduler = new CronScheduler(cronService)
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'cron sidecar test',
      name: 'Sidecar Task',
      recurring: true,
      folderPath: tmpDir,
    })

    const run = await scheduler.executeTask(task)

    expect(run.status).toBe('completed')
    expect(run.output).toBe('sidecar ok')

    const sidecarArgs = (await fs.readFile(sidecarArgsPath, 'utf-8'))
      .trim()
      .split('\n')
    expect(sidecarArgs.slice(0, 4)).toEqual([
      'cli',
      '--app-root',
      appRoot,
      '--print',
    ])
    expect(sidecarArgs).not.toContain(path.join('src', 'entrypoints', 'cli.tsx'))

    const bunWasCalled = await fs
      .stat(bunArgsPath)
      .then(() => true)
      .catch(() => false)
    expect(bunWasCalled).toBe(false)
  })

  unixOnly('executeTask passes provider-scoped model runtime to the sidecar', async () => {
    const appRoot = path.join(tmpDir, 'app-root')
    const sidecarPath = path.join(tmpDir, 'claude-sidecar')
    const sidecarArgsPath = path.join(tmpDir, 'sidecar.args')
    const sidecarEnvPath = path.join(tmpDir, 'sidecar.env')

    await fs.mkdir(appRoot, { recursive: true })
    await fs.writeFile(
      sidecarPath,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > "${sidecarArgsPath}"`,
        `env | sort > "${sidecarEnvPath}"`,
        '/bin/cat >/dev/null',
        'printf \'%s\\n\' \'{"type":"result","result":"provider ok"}\'',
        'exit 0',
        '',
      ].join('\n'),
      'utf-8',
    )
    await fs.chmod(sidecarPath, 0o755)

    process.env.CLAUDE_CLI_PATH = sidecarPath
    process.env.CLAUDE_APP_ROOT = appRoot
    process.env.ANTHROPIC_BASE_URL = 'https://stale-parent.example'
    process.env.ANTHROPIC_MODEL = 'stale-parent-model'
    process.env.CLAUDE_CODE_ENTRYPOINT = 'stale-parent-entrypoint'
    process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'desktop-local-secret'

    const provider = await new ProviderService().addProvider({
      presetId: 'custom',
      name: 'Provider A',
      apiKey: 'provider-key',
      baseUrl: 'https://api.provider.example',
      apiFormat: 'openai_chat',
      models: {
        main: 'provider-main',
        haiku: 'provider-fast',
        sonnet: 'provider-main',
        opus: '',
      },
    })
    const cronService = new CronService()
    const scheduler = new CronScheduler(cronService)
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'cron provider test',
      name: 'Provider Task',
      recurring: true,
      folderPath: tmpDir,
      model: 'provider-fast',
      providerId: provider.id,
    })

    const run = await scheduler.executeTask(task)

    expect(run.status).toBe('completed')
    expect(run.output).toBe('provider ok')

    const sidecarArgs = (await fs.readFile(sidecarArgsPath, 'utf-8'))
      .trim()
      .split('\n')
    expect(sidecarArgs).toContain('--model')
    expect(sidecarArgs[sidecarArgs.indexOf('--model') + 1]).toBe('provider-fast')

    const env = Object.fromEntries(
      (await fs.readFile(sidecarEnvPath, 'utf-8'))
        .trim()
        .split('\n')
        .map((line) => {
          const index = line.indexOf('=')
          return [line.slice(0, index), line.slice(index + 1)]
        }),
    )
    expect(env.ANTHROPIC_BASE_URL).toBe(
      `http://127.0.0.1:3456/proxy/providers/${provider.id}`,
    )
    expect(env.ANTHROPIC_API_KEY).toBe('proxy-managed')
    expect(env.ANTHROPIC_MODEL).toBe('provider-fast')
    expect(env.ANTHROPIC_MODEL).not.toBe('stale-parent-model')
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1')
    expect(env.CC_HAHA_LOCAL_ACCESS_TOKEN).toBe('desktop-local-secret')
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('sdk-cli')
  })

  unixOnly('executeTask applies direct, system, and manual network settings to the sidecar', async () => {
    const appRoot = path.join(tmpDir, 'app-root')
    const sidecarPath = path.join(tmpDir, 'claude-sidecar')
    const sidecarEnvPath = path.join(tmpDir, 'sidecar.env')
    const settingsPath = path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json')

    await fs.mkdir(appRoot, { recursive: true })
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(
      sidecarPath,
      [
        '#!/bin/sh',
        `env | sort > "${sidecarEnvPath}"`,
        '/bin/cat >/dev/null',
        'printf \'%s\\n\' \'{"type":"result","result":"network env ok"}\'',
        'exit 0',
        '',
      ].join('\n'),
      'utf-8',
    )
    await fs.chmod(sidecarPath, 0o755)

    process.env.CLAUDE_CLI_PATH = sidecarPath
    process.env.CLAUDE_APP_ROOT = appRoot
    process.env.CC_HAHA_SYSTEM_PROXY_URL = 'http://127.0.0.1:7897'
    process.env.HTTP_PROXY = 'http://stale-parent.example:8080'
    process.env.HTTPS_PROXY = 'http://stale-parent.example:8080'
    process.env.http_proxy = 'http://stale-parent.example:8080'
    process.env.https_proxy = 'http://stale-parent.example:8080'

    const cronService = new CronService()
    const scheduler = new CronScheduler(cronService)
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'cron network env test',
      name: 'Network Env Task',
      recurring: true,
      folderPath: tmpDir,
    })
    const cases = [
      { mode: 'direct', url: '', expectedProxyUrl: '' },
      { mode: 'system', url: '', expectedProxyUrl: 'http://127.0.0.1:7897' },
      { mode: 'manual', url: ' http://127.0.0.1:7890 ', expectedProxyUrl: 'http://127.0.0.1:7890' },
    ] as const

    for (const testCase of cases) {
      await fs.writeFile(
        settingsPath,
        JSON.stringify({
          network: {
            proxy: { mode: testCase.mode, url: testCase.url },
          },
        }),
        'utf-8',
      )
      resetSettingsCache()

      const run = await scheduler.executeTask(task)
      expect(run.status).toBe('completed')
      expect(run.output).toBe('network env ok')

      const env = Object.fromEntries(
        (await fs.readFile(sidecarEnvPath, 'utf-8'))
          .trim()
          .split('\n')
          .map((line) => {
            const index = line.indexOf('=')
            return [line.slice(0, index), line.slice(index + 1)]
          }),
      )
      expect(env.HTTP_PROXY).toBe(testCase.expectedProxyUrl)
      expect(env.HTTPS_PROXY).toBe(testCase.expectedProxyUrl)
      expect(env.http_proxy).toBe(testCase.expectedProxyUrl)
      expect(env.https_proxy).toBe(testCase.expectedProxyUrl)
    }
  })

  unixOnly('executeTask reloads the General team preference for each new scheduled process', async () => {
    const appRoot = path.join(tmpDir, 'app-root')
    const sidecarPath = path.join(tmpDir, 'claude-sidecar')
    const teamEnvPath = path.join(tmpDir, 'team.env')
    const settingsPath = path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json')
    const envKeys = [
      'CC_HAHA_AGENT_TEAMS_DEFAULT',
      'CC_HAHA_AGENT_TEAMS_ENABLED',
      'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
    ] as const
    const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
    await fs.mkdir(appRoot, { recursive: true })
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(sidecarPath, [
      '#!/bin/sh',
      `printf '%s\\n' "$CC_HAHA_AGENT_TEAMS_DEFAULT" "\${CC_HAHA_AGENT_TEAMS_ENABLED-unset}" "$CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS" > "${teamEnvPath}"`,
      '/bin/cat >/dev/null',
      'printf \'%s\\n\' \'{"type":"result","result":"team env ok"}\'',
      '',
    ].join('\n'))
    await fs.chmod(sidecarPath, 0o755)
    process.env.CLAUDE_CLI_PATH = sidecarPath
    process.env.CLAUDE_APP_ROOT = appRoot
    process.env.HOME = tmpDir
    process.env.CC_HAHA_AGENT_TEAMS_DEFAULT = '0'
    process.env.CC_HAHA_AGENT_TEAMS_ENABLED = '1'
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '0'

    try {
      const cronService = new CronService()
      const scheduler = new CronScheduler(cronService)
      const task = await cronService.createTask({
        cron: '* * * * *',
        prompt: 'cron team environment test',
        recurring: true,
        folderPath: tmpDir,
      })
      for (const enabled of [undefined, true, false, undefined]) {
        await fs.writeFile(settingsPath, JSON.stringify(
          enabled === undefined ? {} : { agentTeamsEnabled: enabled },
        ))
        const run = await scheduler.executeTask(task)
        expect(run.status).toBe('completed')
        expect(run.output).toBe('team env ok')
        expect((await fs.readFile(teamEnvPath, 'utf-8')).trim().split('\n')).toEqual([
          '0',
          enabled === true ? '1' : '0',
          '0',
        ])
      }
    } finally {
      for (const key of envKeys) {
        const value = savedEnv[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  unixOnly('executeTask launches scheduled tasks with full permissions', async () => {
    const appRoot = path.join(tmpDir, 'app-root')
    const sidecarPath = path.join(tmpDir, 'claude-sidecar')
    const sidecarArgsPath = path.join(tmpDir, 'sidecar.args')

    await fs.mkdir(appRoot, { recursive: true })
    await fs.writeFile(
      sidecarPath,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > "${sidecarArgsPath}"`,
        '/bin/cat >/dev/null',
        'printf \'%s\\n\' \'{"type":"result","result":"permissions ok"}\'',
        'exit 0',
        '',
      ].join('\n'),
      'utf-8',
    )
    await fs.chmod(sidecarPath, 0o755)

    process.env.CLAUDE_CLI_PATH = sidecarPath
    process.env.CLAUDE_APP_ROOT = appRoot

    const cronService = new CronService()
    const scheduler = new CronScheduler(cronService)
    const createSessionCalls: unknown[][] = []
    const appendSessionMetadataCalls: unknown[][] = []
    ;(scheduler as unknown as {
      sessionService: {
        createSession: (...args: unknown[]) => Promise<{ sessionId: string }>
        deleteSessionFile: (sessionId: string) => Promise<void>
        appendSessionMetadata: (...args: unknown[]) => Promise<void>
      }
    }).sessionService = {
      createSession: async (...args: unknown[]) => {
        createSessionCalls.push(args)
        return { sessionId: 'scheduled-session' }
      },
      deleteSessionFile: async () => {},
      appendSessionMetadata: async (...args: unknown[]) => {
        appendSessionMetadataCalls.push(args)
      },
    }
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'cron permission test',
      name: 'Permission Task',
      recurring: true,
      folderPath: tmpDir,
      permissionMode: 'default',
    })

    const run = await scheduler.executeTask(task, { createSession: true })
    const canonicalTmpDir = await fs.realpath(tmpDir)

    expect(run.status).toBe('completed')
    expect(run.sessionId).toBe('scheduled-session')
    expect(createSessionCalls).toEqual([[canonicalTmpDir, undefined, 'bypassPermissions']])
    expect(appendSessionMetadataCalls).toEqual([
      ['scheduled-session', { workDir: canonicalTmpDir, permissionMode: 'bypassPermissions' }],
    ])
    const sidecarArgs = (await fs.readFile(sidecarArgsPath, 'utf-8'))
      .trim()
      .split('\n')
    expect(sidecarArgs).toContain('--dangerously-skip-permissions')
    expect(sidecarArgs).toContain('--permission-mode')
    expect(sidecarArgs[sidecarArgs.indexOf('--permission-mode') + 1]).toBe(
      'bypassPermissions',
    )
  })

  unixOnly('executeTask inherits exported terminal shell variables', async () => {
    const appRoot = path.join(tmpDir, 'app-root')
    const sidecarPath = path.join(tmpDir, 'claude-sidecar')
    const sidecarEnvPath = path.join(tmpDir, 'sidecar.env')
    const shellPath = path.join(tmpDir, 'zsh')
    const nodeBin = path.join(tmpDir, 'node-bin')
    const nvmDir = path.join(tmpDir, '.nvm')

    await fs.mkdir(appRoot, { recursive: true })
    await fs.mkdir(nodeBin, { recursive: true })
    await fs.mkdir(nvmDir, { recursive: true })
    await fs.writeFile(
      shellPath,
      [
        '#!/bin/sh',
        'command=',
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = "-c" ]; then',
        '    shift',
        '    command="$1"',
        '    break',
        '  fi',
        '  shift',
        'done',
        'if [ -f "$HOME/.zshrc" ]; then',
        '  . "$HOME/.zshrc" </dev/null >/dev/null 2>/dev/null || true',
        'fi',
        'exec /bin/sh -c "$command"',
        '',
      ].join('\n'),
      'utf-8',
    )
    await fs.chmod(shellPath, 0o755)
    await fs.writeFile(
      path.join(tmpDir, '.zshrc'),
      [
        `export NVM_DIR="${nvmDir}"`,
        `export PATH="${nodeBin}:$PATH"`,
        '',
      ].join('\n'),
    )
    await fs.writeFile(
      sidecarPath,
      [
        '#!/bin/sh',
        `env | sort > "${sidecarEnvPath}"`,
        '/bin/cat >/dev/null',
        'printf \'%s\\n\' \'{"type":"result","result":"shell env ok"}\'',
        'exit 0',
        '',
      ].join('\n'),
      'utf-8',
    )
    await fs.chmod(sidecarPath, 0o755)

    delete process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
    process.env.HOME = tmpDir
    process.env.SHELL = shellPath
    process.env.PATH = '/usr/bin:/bin'
    delete process.env.ZDOTDIR
    process.env.CLAUDE_CLI_PATH = sidecarPath
    process.env.CLAUDE_APP_ROOT = appRoot
    resetTerminalShellEnvironmentCacheForTests()

    const cronService = new CronService()
    const scheduler = new CronScheduler(cronService)
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'cron shell env test',
      name: 'Shell Env Task',
      recurring: true,
      folderPath: tmpDir,
    })

    const run = await scheduler.executeTask(task)

    expect(run.status).toBe('completed')
    expect(run.output).toBe('shell env ok')

    const env = Object.fromEntries(
      (await fs.readFile(sidecarEnvPath, 'utf-8'))
        .trim()
        .split('\n')
        .map((line) => {
          const index = line.indexOf('=')
          return [line.slice(0, index), line.slice(index + 1)]
        }),
    )
    expect(env.NVM_DIR).toBe(nvmDir)
    expect(env.PATH.split(path.delimiter)[0]).toBe(nodeBin)
  })
})
