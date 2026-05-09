import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import {
  buildCronCliArgs,
  CronScheduler,
  resolveCronProjectRoot,
} from '../services/cronScheduler.js'
import { CronService } from '../services/cronService.js'
import { ProviderService } from '../services/providerService.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalPath = process.env.PATH
const originalClaudeCliPath = process.env.CLAUDE_CLI_PATH
const originalClaudeAppRoot = process.env.CLAUDE_APP_ROOT
const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL
const originalAnthropicModel = process.env.ANTHROPIC_MODEL
const originalClaudeCodeEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT

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
}

describe('cron scheduler launcher resolution', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = path.join(tmpDir, 'config')
  })

  afterEach(async () => {
    restoreEnv()
    await cleanupTmpDir(tmpDir)
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
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1')
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('sdk-cli')
  })
})
