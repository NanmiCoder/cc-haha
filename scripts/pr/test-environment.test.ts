import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createOfflineTestEnvironment,
  createSandboxedTestEnvironment,
} from './test-environment'

describe('offline test environment', () => {
  test('keeps ordinary runtime variables while removing credentials and local provider state', () => {
    const environment = createOfflineTestEnvironment({
      HOME: '/tmp/test-home',
      XDG_CONFIG_HOME: '/tmp/test-home/.config',
      CLAUDE_CONFIG_DIR: '/tmp/test-home/.claude',
    }, {
      Path: '/usr/bin',
      CI: 'true',
      DATABASE_URL: 'postgres://user:secret@database.example/app',
      GITHUB_TOKEN: 'real-token',
      ANTHROPIC_API_KEY: 'real-key',
      ANTHROPIC_BASE_URL: 'https://provider.example',
      CLAUDE_CLI_PATH: '/real/claude',
      CC_HAHA_TRACE_PROVIDER_ID: 'real-provider',
      Home: '/real/home',
      HTTP_PROXY: 'http://proxy.example',
      SSH_AUTH_SOCK: '/tmp/real-agent.sock',
      XDG_CONFIG_HOME: '/real/config',
    })

    expect(environment.PATH).toBe('/usr/bin')
    expect(environment.CI).toBe('true')
    expect(environment.HOME).toBe('/tmp/test-home')
    expect(environment.Home).toBeUndefined()
    expect(environment.XDG_CONFIG_HOME).toBe('/tmp/test-home/.config')
    expect(environment.CLAUDE_CONFIG_DIR).toBe('/tmp/test-home/.claude')
    expect(environment.DATABASE_URL).toBeUndefined()
    expect(environment.GITHUB_TOKEN).toBeUndefined()
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined()
    expect(environment.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(environment.CLAUDE_CLI_PATH).toBeUndefined()
    expect(environment.CC_HAHA_TRACE_PROVIDER_ID).toBeUndefined()
    expect(environment.HTTP_PROXY).toBeUndefined()
    expect(environment.SSH_AUTH_SOCK).toBeUndefined()
  })

  test('routes cross-platform user and temporary directories into one sandbox', () => {
    const sandboxHome = mkdtempSync(join(tmpdir(), 'cc-haha-test-env-'))
    try {
      const environment = createSandboxedTestEnvironment(sandboxHome, {}, {
        PATH: '/usr/bin',
        APPDATA: '/real/app-data',
        LOCALAPPDATA: '/real/local-app-data',
        XDG_DATA_HOME: '/real/xdg-data',
      })

      expect(environment.APPDATA).toBe(join(sandboxHome, '.config'))
      expect(environment.LOCALAPPDATA).toBe(join(sandboxHome, '.local'))
      expect(environment.XDG_DATA_HOME).toBe(join(sandboxHome, '.local', 'share'))
      expect(environment.TMPDIR).toBe(join(sandboxHome, 'tmp'))
      expect(environment.NODE_ENV).toBe('test')
      expect(environment.BUN_OPTIONS).toBe('--no-env-file')
      expect(existsSync(environment.TMPDIR)).toBe(true)
    } finally {
      rmSync(sandboxHome, { recursive: true, force: true })
    }
  })

  test('prevents descendant Bun processes from loading a workspace dotenv file', async () => {
    const sandboxHome = mkdtempSync(join(tmpdir(), 'cc-haha-test-env-'))
    const workspace = join(sandboxHome, 'workspace')
    mkdirSync(workspace)
    writeFileSync(
      join(workspace, '.env'),
      'CC_HAHA_DESCENDANT_DOTENV_SENTINEL=leaked\n',
      'utf8',
    )

    try {
      const proc = Bun.spawn(
        [
          'bun',
          '-e',
          'process.stdout.write(process.env.CC_HAHA_DESCENDANT_DOTENV_SENTINEL ?? "clean")',
        ],
        {
          cwd: workspace,
          env: createSandboxedTestEnvironment(sandboxHome),
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])

      expect(exitCode).toBe(0)
      expect(stderr).toBe('')
      expect(stdout).toBe('clean')
    } finally {
      rmSync(sandboxHome, { recursive: true, force: true })
    }
  })
})
