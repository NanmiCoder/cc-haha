import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ConversationService,
  ConversationStartupError,
} from '../services/conversationService.js'

describe('ConversationService startup output', () => {
  let service: ConversationService
  let tmpDir: string
  const originalEnv = new Map<string, string | undefined>()
  const envKeys = [
    'CLAUDE_CLI_PATH',
    'CLAUDE_CONFIG_DIR',
    'CC_HAHA_DISABLE_TERMINAL_SHELL_ENV',
    'MOCK_SDK_STARTUP_STDOUT',
    'MOCK_SDK_STARTUP_STDERR',
    'MOCK_SDK_STARTUP_EXIT_CODE',
  ]

  beforeEach(async () => {
    service = new ConversationService()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-startup-output-'))
    for (const key of envKeys) {
      originalEnv.set(key, process.env[key])
    }

    process.env.CLAUDE_CLI_PATH = fileURLToPath(
      new URL('./fixtures/mock-startup-exit-cli.ts', import.meta.url),
    )
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
    process.env.MOCK_SDK_STARTUP_STDOUT = 'provider rejected request: invalid model id'
  })

  afterEach(async () => {
    await service.stopAllSessionsAndWait(1_000)
    for (const key of envKeys) {
      const value = originalEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    originalEnv.clear()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('includes CLI stdout when the process exits before SDK messages', async () => {
    let startupError: unknown

    try {
      await service.startSession(
        `startup-output-${crypto.randomUUID()}`,
        tmpDir,
        'ws://127.0.0.1:1/sdk/startup-output?token=test-token',
      )
    } catch (error) {
      startupError = error
    }

    expect(startupError).toBeInstanceOf(ConversationStartupError)
    expect(startupError).toMatchObject({ code: 'CLI_START_FAILED' })
    expect((startupError as Error).message).toContain(
      'CLI exited during startup (code 1): provider rejected request: invalid model id',
    )
  }, 10_000)

  // The crash report from issue #1475 does not itself establish that the
  // machine's commit limit was exhausted.
  const windowsBunCrash = [
    '============================================================',
    'Bun v1.3.14 (0d9b296a) Windows x64 (baseline)',
    'Windows v.win11_dt',
    'CPU: sse42 avx avx2',
    'Features: jsc',
    'Elapsed: 689ms | User: 0ms | Sys: 46ms',
    'RSS: 59.50MB | Peak: 59.50MB | Commit: 52.00MB | Faults: 14677',
    'panic(main thread): Illegal instruction at address 0x7FF7A70604F0',
    'oh no: Bun has crashed. This indicates a bug in Bun, not your code.',
  ].join('\n')

  const startupFailure = async (): Promise<Error> => {
    try {
      await service.startSession(
        `startup-output-${crypto.randomUUID()}`,
        tmpDir,
        'ws://127.0.0.1:1/sdk/startup-output?token=test-token',
      )
    } catch (error) {
      return error as Error
    }
    throw new Error('startup unexpectedly succeeded')
  }

  test('keeps a Windows Bun illegal-instruction report without guessing a memory cause', async () => {
    delete process.env.MOCK_SDK_STARTUP_STDOUT
    process.env.MOCK_SDK_STARTUP_STDERR = windowsBunCrash
    process.env.MOCK_SDK_STARTUP_EXIT_CODE = '3'

    const error = await startupFailure()

    expect(error).toBeInstanceOf(ConversationStartupError)
    expect(error).toMatchObject({ code: 'CLI_START_FAILED' })
    expect(error.message).toStartWith('CLI runtime crashed during startup (code 3).')
    expect(error.message).toContain('Illegal instruction at address 0x7FF7A70604F0')
    expect(error.message).not.toContain('commit memory')
    expect(error.message).not.toContain('page file')
  }, 10_000)

  test('keeps the reported Bun 1.4.3 segfault and report link without claiming memory exhaustion', async () => {
    const reportUrl = 'https://bun.report/1.4.3/w_1c6da4a4EggggC+y2jlC6/vklCA2AQ'
    delete process.env.MOCK_SDK_STARTUP_STDOUT
    process.env.MOCK_SDK_STARTUP_STDERR = [
      'Bun v1.4.3 (c6da4a4d3) Windows x64',
      'Windows v10.26200',
      'RSS: 83.34 MB | Peak: 83.34 MB | Commit: 66.60 MB | Faults: 20499 | Machine: 33.95 GB',
      'panic(main thread): Segmentation fault at address 0x8',
      'oh no: Bun has crashed. This indicates a bug in Bun, not your code.',
      reportUrl,
    ].join('\n')
    process.env.MOCK_SDK_STARTUP_EXIT_CODE = '3'

    const error = await startupFailure()

    expect(error).toMatchObject({ code: 'CLI_START_FAILED' })
    expect(error.message).toStartWith('CLI runtime crashed during startup (code 3).')
    expect(error.message).toContain('Bun v1.4.3 (c6da4a4d3) Windows x64')
    expect(error.message).toContain('panic(main thread): Segmentation fault at address 0x8')
    expect(error.message).toContain(reportUrl)
    expect(error.message).not.toContain('commit memory')
    expect(error.message).not.toContain('page file')
  }, 10_000)

  test('does not infer a crash or memory cause from exit code 3 alone', async () => {
    delete process.env.MOCK_SDK_STARTUP_STDOUT
    process.env.MOCK_SDK_STARTUP_EXIT_CODE = '3'

    const error = await startupFailure()

    expect(error.message).toBe('CLI exited during startup with code 3; no CLI stderr/stdout or SDK error payload was captured before exit.')
  }, 10_000)

  test('preserves explicit memory-allocation failure evidence without inferring the system commit state', async () => {
    delete process.env.MOCK_SDK_STARTUP_STDOUT
    process.env.MOCK_SDK_STARTUP_STDERR = windowsBunCrash.replace(
      'Illegal instruction at address 0x7FF7A70604F0',
      'Out of memory: failed to allocate memory',
    )
    process.env.MOCK_SDK_STARTUP_EXIT_CODE = '3'

    const error = await startupFailure()

    expect(error.message).toStartWith('CLI runtime crashed during startup (code 3).')
    expect(error.message).toContain('panic(main thread): Out of memory: failed to allocate memory')
    expect(error.message).not.toContain('system has run out of commit memory')
  }, 10_000)

  test('leaves a Bun crash on other platforms as a plain startup exit', async () => {
    delete process.env.MOCK_SDK_STARTUP_STDOUT
    process.env.MOCK_SDK_STARTUP_STDERR = windowsBunCrash.replace(/Windows[^\n]*/g, 'macOS arm64')
    process.env.MOCK_SDK_STARTUP_EXIT_CODE = '3'

    const error = await startupFailure()

    expect(error.message).toStartWith('CLI exited during startup (code 3): ')
    expect(error.message).not.toContain('commit memory')
  }, 10_000)
})
