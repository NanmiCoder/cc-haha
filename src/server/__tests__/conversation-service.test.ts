import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildConversationCliSpawnOptions,
  ConversationService,
  DESKTOP_CLI_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
} from '../services/conversationService.js'
import { ProviderService } from '../services/providerService.js'
import { updateTraceCaptureSettings } from '../services/traceCaptureService.js'
import { resetTerminalShellEnvironmentCacheForTests } from '../../utils/terminalShellEnvironment.js'

describe('ConversationService', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let originalApiKey: string | undefined
  let originalAuthToken: string | undefined
  let originalBaseUrl: string | undefined
  let originalModel: string | undefined
  let originalEntrypoint: string | undefined
  let originalOAuthToken: string | undefined
  let originalProviderManagedByHost: string | undefined
  let originalDiagnosticsFile: string | undefined
  let originalAttributionHeader: string | undefined
  let originalResumeInterruptedTurn: string | undefined
  let originalTraceApiCalls: string | undefined
  let originalTraceProviderId: string | undefined
  let originalTraceProviderName: string | undefined
  let originalTraceProviderFormat: string | undefined
  let originalHome: string | undefined
  let originalPath: string | undefined
  let originalShell: string | undefined
  let originalZdotdir: string | undefined
  let originalDisableTerminalShellEnv: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-conversation-service-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalApiKey = process.env.ANTHROPIC_API_KEY
    originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN
    originalBaseUrl = process.env.ANTHROPIC_BASE_URL
    originalModel = process.env.ANTHROPIC_MODEL
    originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
    originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    originalProviderManagedByHost = process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    originalDiagnosticsFile = process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
    originalAttributionHeader = process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
    originalResumeInterruptedTurn = process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN
    originalTraceApiCalls = process.env.CC_HAHA_TRACE_API_CALLS
    originalTraceProviderId = process.env.CC_HAHA_TRACE_PROVIDER_ID
    originalTraceProviderName = process.env.CC_HAHA_TRACE_PROVIDER_NAME
    originalTraceProviderFormat = process.env.CC_HAHA_TRACE_PROVIDER_FORMAT
    originalHome = process.env.HOME
    originalPath = process.env.PATH
    originalShell = process.env.SHELL
    originalZdotdir = process.env.ZDOTDIR
    originalDisableTerminalShellEnv = process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV

    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.ANTHROPIC_API_KEY = 'stale-parent-api-key'
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token'
    process.env.ANTHROPIC_BASE_URL = 'https://example.invalid/anthropic'
    process.env.ANTHROPIC_MODEL = 'test-model'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'inherited-parent-oauth-token'
    // Clear inherited CLAUDE_CODE_ENTRYPOINT so tests can assert whether
    // buildChildEnv injects it or not without interference from the shell env.
    delete process.env.CLAUDE_CODE_ENTRYPOINT
    delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    delete process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
    delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
    delete process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN
    delete process.env.CC_HAHA_TRACE_API_CALLS
    delete process.env.CC_HAHA_TRACE_PROVIDER_ID
    delete process.env.CC_HAHA_TRACE_PROVIDER_NAME
    delete process.env.CC_HAHA_TRACE_PROVIDER_FORMAT
    process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
    resetTerminalShellEnvironmentCacheForTests()
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir

    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = originalApiKey

    if (originalAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
    else process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken

    if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = originalBaseUrl

    if (originalModel === undefined) delete process.env.ANTHROPIC_MODEL
    else process.env.ANTHROPIC_MODEL = originalModel

    if (originalEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT
    else process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint

    if (originalOAuthToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken

    if (originalProviderManagedByHost === undefined) delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    else process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = originalProviderManagedByHost

    if (originalDiagnosticsFile === undefined) delete process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
    else process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = originalDiagnosticsFile

    if (originalAttributionHeader === undefined) delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
    else process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = originalAttributionHeader

    if (originalResumeInterruptedTurn === undefined) delete process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN
    else process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN = originalResumeInterruptedTurn

    if (originalTraceApiCalls === undefined) delete process.env.CC_HAHA_TRACE_API_CALLS
    else process.env.CC_HAHA_TRACE_API_CALLS = originalTraceApiCalls

    if (originalTraceProviderId === undefined) delete process.env.CC_HAHA_TRACE_PROVIDER_ID
    else process.env.CC_HAHA_TRACE_PROVIDER_ID = originalTraceProviderId

    if (originalTraceProviderName === undefined) delete process.env.CC_HAHA_TRACE_PROVIDER_NAME
    else process.env.CC_HAHA_TRACE_PROVIDER_NAME = originalTraceProviderName

    if (originalTraceProviderFormat === undefined) delete process.env.CC_HAHA_TRACE_PROVIDER_FORMAT
    else process.env.CC_HAHA_TRACE_PROVIDER_FORMAT = originalTraceProviderFormat

    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome

    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath

    if (originalShell === undefined) delete process.env.SHELL
    else process.env.SHELL = originalShell

    if (originalZdotdir === undefined) delete process.env.ZDOTDIR
    else process.env.ZDOTDIR = originalZdotdir

    if (originalDisableTerminalShellEnv === undefined) delete process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
    else process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = originalDisableTerminalShellEnv

    resetTerminalShellEnvironmentCacheForTests()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function writeFakeZsh(filePath: string) {
    await fs.writeFile(
      filePath,
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
      { mode: 0o755 },
    )
  }

  test('keeps inherited provider env when no desktop provider config exists', async () => {
    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('D:\\workspace\\code\\myself_code\\cc-haha')) as Record<string, string>

    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('test-token')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://example.invalid/anthropic')
    expect(env.ANTHROPIC_MODEL).toBe('test-model')
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
    expect(env.CLAUDE_CODE_DIAGNOSTICS_FILE).toBe(path.join(tmpDir, 'cc-haha', 'diagnostics', 'cli-diagnostics.jsonl'))
    expect(env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE).toBe(
      `${path.join(tmpDir, 'projects', 'D--workspace-code-myself-code-cc-haha', 'memory')}${path.sep}`,
    )
    await expect(fs.stat(path.dirname(env.CLAUDE_CODE_DIAGNOSTICS_FILE))).resolves.toBeTruthy()
  })

  test('buildChildEnv injects stream watchdog + overall max-duration so a trickling provider stream cannot hang the desktop forever (#766)', async () => {
    const prev = process.env.CLAUDE_STREAM_MAX_DURATION_MS
    delete process.env.CLAUDE_STREAM_MAX_DURATION_MS
    try {
      const service = new ConversationService() as any
      const env = (await service.buildChildEnv('/tmp')) as Record<string, string>

      // Idle watchdog frees a fully-silent stream after 240s...
      expect(env.CLAUDE_ENABLE_STREAM_WATCHDOG).toBe('1')
      expect(env.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe('240000')
      // ...but the idle timer is reset by EVERY SSE event, so an upstream that
      // trickles content deltas (a large tool_use input_json_delta) just under
      // 240s apart keeps it alive forever. The overall-duration cap is NOT reset
      // by chunks and is what actually frees that case (#766).
      expect(env.CLAUDE_STREAM_MAX_DURATION_MS).toBe('600000')
      // Non-streaming fallback stays off — its retry loop also hangs the UI (#766).
      expect(env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK).toBe('1')
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_STREAM_MAX_DURATION_MS
      else process.env.CLAUDE_STREAM_MAX_DURATION_MS = prev
    }
  })

  test('buildChildEnv lets caller env override the stream max-duration cap (#766)', async () => {
    const prev = process.env.CLAUDE_STREAM_MAX_DURATION_MS
    process.env.CLAUDE_STREAM_MAX_DURATION_MS = '120000'
    try {
      const service = new ConversationService() as any
      const env = (await service.buildChildEnv('/tmp')) as Record<string, string>
      expect(env.CLAUDE_STREAM_MAX_DURATION_MS).toBe('120000')
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_STREAM_MAX_DURATION_MS
      else process.env.CLAUDE_STREAM_MAX_DURATION_MS = prev
    }
  })

  test('builds hidden CLI spawn options for desktop session subprocesses', () => {
    const env = { CLAUDECODE: '1' }

    expect(buildConversationCliSpawnOptions('/workspace/project', env)).toEqual({
      cwd: '/workspace/project',
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    })
  })

  test('buildChildEnv pins desktop memory to the current sanitized project directory', async () => {
    const service = new ConversationService() as any
    const workDir = path.join(tmpDir, 'workspace', 'myself_code', 'claude-code-haha')
    await fs.mkdir(workDir, { recursive: true })

    const env = (await service.buildChildEnv(workDir)) as Record<string, string>

    expect(env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE).toBe(
      `${path.join(tmpDir, 'projects', sanitizeMemoryPath(workDir), 'memory')}${path.sep}`,
    )
    expect(env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE).toContain('myself-code')
    expect(env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE).not.toContain('myself_code')
  })

  test('buildChildEnv inherits exported terminal shell variables for desktop CLI sessions', async () => {
    const shellPath = path.join(tmpDir, 'zsh')
    const nodeBin = path.join(tmpDir, 'node-bin')
    const nvmDir = path.join(tmpDir, '.nvm')
    await fs.mkdir(nodeBin, { recursive: true })
    await fs.mkdir(nvmDir, { recursive: true })
    await writeFakeZsh(shellPath)
    await fs.writeFile(
      path.join(tmpDir, '.zshrc'),
      [
        `export NVM_DIR="${nvmDir}"`,
        `export PATH="${nodeBin}:$PATH"`,
        '',
      ].join('\n'),
    )

    delete process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
    process.env.HOME = tmpDir
    process.env.SHELL = shellPath
    process.env.PATH = '/usr/bin:/bin'
    delete process.env.ZDOTDIR
    resetTerminalShellEnvironmentCacheForTests()

    const service = new ConversationService() as any
    const env = (await service.buildChildEnv(tmpDir)) as Record<string, string>

    expect(env.NVM_DIR).toBe(nvmDir)
    expect(env.PATH.split(path.delimiter)[0]).toBe(nodeBin)
    expect(env.PATH.split(path.delimiter)).toContain('/usr/bin')
  })

  test('strips inherited provider env when desktop provider config exists', async () => {
    const ccHahaDir = path.join(tmpDir, 'cc-haha')
    await fs.mkdir(ccHahaDir, { recursive: true })
    await fs.writeFile(
      path.join(ccHahaDir, 'providers.json'),
      JSON.stringify({ activeId: null, providers: [] }),
      'utf-8',
    )

    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('D:\\workspace\\code\\myself_code\\cc-haha')) as Record<string, string>

    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.ANTHROPIC_MODEL).toBeUndefined()
  })

  test('buildChildEnv injects General network timeout and manual proxy for CLI requests', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        network: {
          aiRequestTimeoutMs: 180_000,
          proxy: {
            mode: 'manual',
            url: ' http://127.0.0.1:7890 ',
          },
        },
      }),
      'utf-8',
    )

    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('/tmp')) as Record<string, string>

    expect(env.API_TIMEOUT_MS).toBe('180000')
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
  })

  test('buildChildEnv ties the first-token watchdog to the user request timeout so slow prefill is not killed early (#826)', async () => {
    const prev = process.env.CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS
    delete process.env.CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({ network: { aiRequestTimeoutMs: 600_000 } }),
      'utf-8',
    )
    try {
      const service = new ConversationService() as any
      const env = (await service.buildChildEnv('/tmp')) as Record<string, string>

      // The user's "请求超时" must reach the first-token watchdog, not only the
      // SDK client timeout (which on a stream is cleared the moment response
      // headers arrive). Otherwise a local/3P model that needs minutes to emit
      // its first token gets killed by the 240s idle watchdog no matter how high
      // the configured timeout is (#826).
      expect(env.CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS).toBe('600000')
      expect(env.CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS).toBe(env.API_TIMEOUT_MS)
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS
      else process.env.CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS = prev
    }
  })

  test('buildChildEnv lets caller env override the first-token watchdog (#826)', async () => {
    const prev = process.env.CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS
    process.env.CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS = '900000'
    try {
      const service = new ConversationService() as any
      const env = (await service.buildChildEnv('/tmp')) as Record<string, string>
      expect(env.CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS).toBe('900000')
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS
      else process.env.CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS = prev
    }
  })

  test('buildChildEnv injects CLAUDE_CODE_OAUTH_TOKEN when official mode + haha oauth token exists', async () => {
    const ccHahaDir = path.join(tmpDir, 'cc-haha')
    await fs.mkdir(ccHahaDir, { recursive: true })
    await fs.writeFile(
      path.join(ccHahaDir, 'settings.json'),
      JSON.stringify({ env: {} }),
      'utf-8',
    )

    const { hahaOAuthService } = await import('../services/hahaOAuthService.js')
    await hahaOAuthService.saveTokens({
      accessToken: 'haha-fresh-token',
      refreshToken: 'haha-refresh-xxx',
      expiresAt: Date.now() + 30 * 60_000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    })

    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('/tmp')) as Record<string, string>

    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('claude-desktop')
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('haha-fresh-token')
  })

  test('sendMessage updates a running official OAuth CLI token before the user turn', async () => {
    const { hahaOAuthService } = await import('../services/hahaOAuthService.js')
    await hahaOAuthService.saveTokens({
      accessToken: 'fresh-after-wake-token',
      refreshToken: 'refresh-xxx',
      expiresAt: Date.now() + 30 * 60_000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    })

    const service = new ConversationService() as any
    const sent: string[] = []
    service.sessions.set('sleep-wake-session', {
      proc: {},
      outputCallbacks: [],
      workDir: tmpDir,
      permissionMode: 'default',
      sdkToken: 'sdk-token',
      sdkSocket: {
        send(line: string) {
          sent.push(line)
        },
      },
      pendingOutbound: [],
      startupPending: false,
      startupExitCode: null,
      stdoutLines: [],
      stderrLines: [],
      outputDrain: Promise.resolve(),
      sdkMessages: [],
      initMessage: null,
      pendingPermissionRequests: new Map(),
      usesOfficialOAuth: true,
      officialOAuthToken: 'stale-before-sleep-token',
    })

    const ok = await service.sendMessage('sleep-wake-session', 'hello after wake')

    expect(ok).toBe(true)
    expect(sent).toHaveLength(2)
    expect(JSON.parse(sent[0]!).type).toBe('update_environment_variables')
    expect(JSON.parse(sent[0]!).variables.CLAUDE_CODE_OAUTH_TOKEN).toBe('fresh-after-wake-token')
    expect(JSON.parse(sent[1]!).type).toBe('user')
  })

  test('buildChildEnv does NOT inject CLAUDE_CODE_OAUTH_TOKEN when not official mode', async () => {
    const ccHahaDir = path.join(tmpDir, 'cc-haha')
    await fs.mkdir(ccHahaDir, { recursive: true })
    await fs.writeFile(
      path.join(ccHahaDir, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'custom-provider-token' } }),
      'utf-8',
    )

    const { hahaOAuthService } = await import('../services/hahaOAuthService.js')
    await hahaOAuthService.saveTokens({
      accessToken: 'haha-token-should-not-be-used',
      refreshToken: null,
      expiresAt: null,
      scopes: [],
      subscriptionType: null,
    })

    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('/tmp')) as Record<string, string>

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
  })

  test('buildChildEnv injects explicit provider runtime env for session-scoped providers', async () => {
    const providerService = new ProviderService()
    const provider = await providerService.addProvider({
      presetId: 'custom',
      name: 'Packy',
      apiKey: 'provider-key',
      baseUrl: 'https://api.packy.example',
      apiFormat: 'openai_chat',
      models: {
        main: 'kimi-k2.6',
        haiku: '',
        sonnet: '',
        opus: '',
      },
    })

    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('/tmp', undefined, {
      providerId: provider.id,
    })) as Record<string, string>

    expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:3456/proxy/providers/${provider.id}`)
    expect(env.ANTHROPIC_API_KEY).toBe('proxy-managed')
    expect(env.ANTHROPIC_MODEL).toBe('kimi-k2.6')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-k2.6')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-k2.6')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-k2.6')
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1')
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(env.CC_HAHA_TRACE_PROVIDER_ID).toBeUndefined()
    expect(env.CC_HAHA_TRACE_PROVIDER_NAME).toBeUndefined()
    expect(env.CC_HAHA_TRACE_PROVIDER_FORMAT).toBeUndefined()
  })

  test('buildChildEnv injects trace provider metadata for desktop sdk session-scoped providers', async () => {
    const providerService = new ProviderService()
    const provider = await providerService.addProvider({
      presetId: 'custom',
      name: 'Traceable Provider',
      apiKey: 'provider-key',
      baseUrl: 'https://traceable.example',
      apiFormat: 'anthropic',
      models: {
        main: 'gpt-5.5',
        haiku: '',
        sonnet: '',
        opus: '',
      },
    })

    const service = new ConversationService() as any
    const env = (await service.buildChildEnv(
      '/tmp',
      'ws://127.0.0.1:3456/sdk/test-session?token=test-token',
      { providerId: provider.id },
    )) as Record<string, string>

    expect(env.CC_HAHA_TRACE_API_CALLS).toBe('1')
    expect(env.CC_HAHA_TRACE_PROVIDER_ID).toBe(provider.id)
    expect(env.CC_HAHA_TRACE_PROVIDER_NAME).toBe('Traceable Provider')
    expect(env.CC_HAHA_TRACE_PROVIDER_FORMAT).toBe('anthropic')
  })

  test('buildChildEnv does not inject trace env when managed trace capture is disabled', async () => {
    await updateTraceCaptureSettings({ enabled: false })
    const providerService = new ProviderService()
    const provider = await providerService.addProvider({
      presetId: 'custom',
      name: 'Trace disabled provider',
      apiKey: 'provider-key',
      baseUrl: 'https://traceable.example',
      apiFormat: 'anthropic',
      models: {
        main: 'gpt-5.5',
        haiku: '',
        sonnet: '',
        opus: '',
      },
    })

    const service = new ConversationService() as any
    const env = (await service.buildChildEnv(
      '/tmp',
      'ws://127.0.0.1:3456/sdk/test-session?token=test-token',
      { providerId: provider.id },
    )) as Record<string, string>

    expect(env.CC_HAHA_TRACE_API_CALLS).toBeUndefined()
    expect(env.CC_HAHA_TRACE_PROVIDER_ID).toBeUndefined()
    expect(env.CC_HAHA_TRACE_PROVIDER_NAME).toBeUndefined()
    expect(env.CC_HAHA_TRACE_PROVIDER_FORMAT).toBeUndefined()
  })

  test('buildChildEnv uses the session-selected model for session-scoped providers', async () => {
    const providerService = new ProviderService()
    const provider = await providerService.addProvider({
      presetId: 'custom',
      name: 'Switchable',
      apiKey: 'provider-key',
      baseUrl: 'https://api.switchable.example',
      apiFormat: 'openai_chat',
      models: {
        main: 'old-provider-main',
        haiku: 'new-provider-haiku',
        sonnet: 'new-provider-sonnet',
        opus: 'new-provider-opus',
      },
    })

    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('/tmp', undefined, {
      providerId: provider.id,
      model: 'new-provider-sonnet',
    })) as Record<string, string>

    expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:3456/proxy/providers/${provider.id}`)
    expect(env.ANTHROPIC_MODEL).toBe('new-provider-sonnet')
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
  })

  test('buildChildEnv clears stale api key for bearer-token providers', async () => {
    const providerService = new ProviderService()
    const provider = await providerService.addProvider({
      presetId: 'jiekouai',
      name: 'Jiekou',
      apiKey: 'provider-key',
      baseUrl: 'https://api.jiekou.ai/anthropic',
      apiFormat: 'anthropic',
      models: {
        main: 'claude-sonnet-4-6',
        haiku: 'claude-haiku-4-5-20251001',
        sonnet: 'claude-sonnet-4-6',
        opus: 'claude-opus-4-7',
      },
    })

    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('/tmp', undefined, {
      providerId: provider.id,
      model: 'claude-sonnet-4-6',
    })) as Record<string, string>

    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.jiekou.ai/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('provider-key')
    expect(env.ANTHROPIC_API_KEY).toBe('')
    expect(env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES).toBe('none')
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('1')
  })

  test('buildChildEnv lets General network timeout override provider preset timeouts', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        network: {
          aiRequestTimeoutMs: 180_000,
          proxy: { mode: 'system', url: '' },
        },
      }),
      'utf-8',
    )

    const providerService = new ProviderService()
    const provider = await providerService.addProvider({
      presetId: 'shengsuanyun',
      name: 'Shengsuanyun',
      apiKey: 'provider-key',
      baseUrl: 'https://router.shengsuanyun.com/api',
      apiFormat: 'anthropic',
      models: {
        main: 'anthropic/claude-sonnet-4.6',
        haiku: 'anthropic/claude-haiku-4.5:thinking',
        sonnet: 'anthropic/claude-sonnet-4.6',
        opus: 'anthropic/claude-opus-4.7',
      },
    })

    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('/tmp', undefined, {
      providerId: provider.id,
      model: 'anthropic/claude-sonnet-4.6',
    })) as Record<string, string>

    expect(env.ANTHROPIC_BASE_URL).toBe('https://router.shengsuanyun.com/api')
    expect(env.API_TIMEOUT_MS).toBe('180000')
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
  })

  test('buildChildEnv can force official auth even when a custom default provider exists', async () => {
    const ccHahaDir = path.join(tmpDir, 'cc-haha')
    await fs.mkdir(ccHahaDir, { recursive: true })
    await fs.writeFile(
      path.join(ccHahaDir, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'custom-provider-token' } }),
      'utf-8',
    )

    const { hahaOAuthService } = await import('../services/hahaOAuthService.js')
    await hahaOAuthService.saveTokens({
      accessToken: 'forced-official-token',
      refreshToken: 'forced-official-refresh',
      expiresAt: Date.now() + 30 * 60_000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    })

    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('/tmp', undefined, {
      providerId: null,
    })) as Record<string, string>

    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('claude-desktop')
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('forced-official-token')
  })

  test('buildChildEnv does not inject Claude OAuth when ChatGPT Official is active', async () => {
    const providerService = new ProviderService()
    await providerService.activateProvider('openai-official')

    const { hahaOAuthService } = await import('../services/hahaOAuthService.js')
    await hahaOAuthService.saveTokens({
      accessToken: 'claude-oauth-token-that-must-not-be-used',
      refreshToken: 'claude-refresh-token',
      expiresAt: Date.now() + 30 * 60_000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    })

    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('/tmp')) as Record<string, string>

    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  test('buildChildEnv injects ChatGPT Official runtime env for session-scoped provider selection', async () => {
    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('/tmp', undefined, {
      providerId: 'openai-official',
    })) as Record<string, string>

    expect(env.CC_HAHA_OPENAI_OAUTH_PROVIDER).toBe('1')
    expect(env.OPENAI_CODEX_OAUTH_FILE).toBe(
      path.join(tmpDir, 'cc-haha', 'openai-oauth.json'),
    )
    expect(env.ANTHROPIC_MODEL).toBe('gpt-5.3-codex')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.4')
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1')
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  test('buildChildEnv does not leak inherited CLAUDE_CODE_OAUTH_TOKEN when official token is unavailable', async () => {
    const ccHahaDir = path.join(tmpDir, 'cc-haha')
    await fs.mkdir(ccHahaDir, { recursive: true })
    await fs.writeFile(
      path.join(ccHahaDir, 'settings.json'),
      JSON.stringify({ env: {} }),
      'utf-8',
    )

    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('/tmp')) as Record<string, string>

    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('claude-desktop')
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  test('buildChildEnv injects desktop Computer Use host bundle id for sdk sessions', async () => {
    const service = new ConversationService() as any
    const env = (await service.buildChildEnv(
      '/tmp',
      'ws://127.0.0.1:3456/sdk/test-session?token=test-token',
    )) as Record<string, string>

    expect(env.CC_HAHA_COMPUTER_USE_HOST_BUNDLE_ID).toBe(
      'com.claude-code-haha.desktop',
    )
    expect(env.CC_HAHA_DESKTOP_SERVER_URL).toBe('http://127.0.0.1:3456')
    expect(env.CC_HAHA_TRACE_API_CALLS).toBe('1')
    expect(env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBe('1')
  })

  test('uses bun entrypoint fallback on Windows dev mode', () => {
    const service = new ConversationService() as any
    const args = service.resolveCliArgs(['--print'])

    if (process.platform === 'win32') {
      expect(args[0]).toBe(process.execPath)
      expect(args[1]).toBe('--preload')
      expect(args[2]).toContain('preload.ts')
      expect(args[3]).toContain(path.join('src', 'entrypoints', 'cli.tsx'))
    } else {
      expect(args[0]).toContain(path.join('bin', 'claude-haha'))
    }
  })

  test('buildSessionCliArgs enables partial assistant messages for desktop streaming', () => {
    const service = new ConversationService() as any
    const args = service.buildSessionCliArgs(
      '123e4567-e89b-12d3-a456-426614174000',
      'ws://127.0.0.1:3456/sdk/test-session?token=test-token',
      false,
      { permissionMode: 'bypassPermissions' },
    ) as string[]

    expect(args).toContain('--include-partial-messages')
    expect(args).toContain('--sdk-url')
    expect(args).toContain('--replay-user-messages')
  })

  test('buildChildEnv asks desktop SDK sessions to wait briefly for MCP tools', async () => {
    const service = new ConversationService() as any
    const env = (await service.buildChildEnv(
      '/tmp',
      'ws://127.0.0.1:3456/sdk/test-session?token=test-token',
    )) as Record<string, string>

    expect(env.CC_HAHA_DESKTOP_AWAIT_MCP).toBe('1')
    expect(env.CC_HAHA_DESKTOP_AWAIT_MCP_TIMEOUT_MS).toBe('5000')
  })

  test('buildChildEnv disables inherited interrupted-turn resume for prewarm launches', async () => {
    process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN = '1'
    const service = new ConversationService() as any
    const env = (await service.buildChildEnv(
      '/tmp',
      'ws://127.0.0.1:3456/sdk/test-session?token=test-token',
      { resumeInterruptedTurn: false },
    )) as Record<string, string>

    expect(env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBeUndefined()
  })

  test('buildChildEnv enables stream idle watchdog for desktop CLI sessions', async () => {
    const service = new ConversationService() as any
    const env = (await service.buildChildEnv(
      '/tmp',
      'ws://127.0.0.1:3456/sdk/test-session?token=test-token',
    )) as Record<string, string>

    expect(env.CLAUDE_ENABLE_STREAM_WATCHDOG).toBe('1')
  })

  test('buildChildEnv widens the stream idle window and disables the non-streaming fallback (#766)', async () => {
    const service = new ConversationService() as any
    const env = (await service.buildChildEnv(
      '/tmp',
      'ws://127.0.0.1:3456/sdk/test-session?token=test-token',
    )) as Record<string, string>

    // 90s default kills healthy-but-silent third-party streams; 240s keeps the
    // watchdog useful without aborting slow thinking/prefill phases.
    expect(env.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe('240000')
    // Non-streaming fallback can never finish for slow providers (first byte
    // only arrives after FULL generation), so retries must stay streaming.
    expect(env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK).toBe('1')
  })

  test('buildChildEnv respects caller overrides for stream timeout tuning envs', async () => {
    const service = new ConversationService() as any
    const previous = {
      watchdog: process.env.CLAUDE_ENABLE_STREAM_WATCHDOG,
      idle: process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS,
      fallback: process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK,
    }
    process.env.CLAUDE_ENABLE_STREAM_WATCHDOG = '0'
    process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '90000'
    process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = '0'
    try {
      const env = (await service.buildChildEnv(
        '/tmp',
        'ws://127.0.0.1:3456/sdk/test-session?token=test-token',
      )) as Record<string, string>

      expect(env.CLAUDE_ENABLE_STREAM_WATCHDOG).toBe('0')
      expect(env.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe('90000')
      expect(env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK).toBe('0')
    } finally {
      for (const [key, value] of [
        ['CLAUDE_ENABLE_STREAM_WATCHDOG', previous.watchdog],
        ['CLAUDE_STREAM_IDLE_TIMEOUT_MS', previous.idle],
        ['CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK', previous.fallback],
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  test('buildSessionCliArgs forwards the selected runtime model and effort to the CLI process', () => {
    const service = new ConversationService() as any
    const args = service.buildSessionCliArgs(
      '123e4567-e89b-12d3-a456-426614174000',
      'ws://127.0.0.1:3456/sdk/test-session?token=test-token',
      false,
      {
        model: 'model-b-opus',
        effort: 'max',
      },
    ) as string[]

    expect(args).toContain('--model')
    expect(args).toContain('model-b-opus')
    expect(args).toContain('--effort')
    expect(args).toContain('max')
  })

  test('buildSessionCliArgs starts pending desktop worktrees through the native CLI flag', () => {
    const service = new ConversationService() as any
    const args = service.buildSessionCliArgs(
      '123e4567-e89b-12d3-a456-426614174000',
      'ws://127.0.0.1:3456/sdk/test-session?token=test-token',
      false,
      undefined,
      {
        requestedWorkDir: '/tmp/source-repo',
        repoRoot: '/tmp/source-repo',
        branch: 'feature/rail',
        worktree: true,
        baseRef: 'feature/rail',
        worktreeSlug: 'desktop-feature-rail-123e4567',
      },
    ) as string[]

    expect(args).toContain('--worktree')
    expect(args).toContain('desktop-feature-rail-123e4567')
    expect(args).toContain('--worktree-base-ref')
    expect(args).toContain('feature/rail')
  })

  test('stopAllSessionsAndWait kills every active CLI subprocess and waits for exits', async () => {
    const service = new ConversationService() as any
    const killed: string[] = []
    const drained: string[] = []

    const makeSession = (sessionId: string) => {
      let resolveExit: (code: number) => void = () => {}
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve
      })

      return {
        proc: {
          kill: () => {
            killed.push(sessionId)
            resolveExit(0)
          },
          exited,
        },
        outputCallbacks: [],
        workDir: tmpDir,
        permissionMode: 'default',
        sdkToken: `${sessionId}-token`,
        sdkSocket: null,
        pendingOutbound: [],
        startupPending: false,
        startupExitCode: null,
        stdoutLines: [],
        stderrLines: [],
        outputDrain: Promise.resolve().then(() => {
          drained.push(sessionId)
        }),
        sdkMessages: [],
        initMessage: null,
        pendingPermissionRequests: new Map(),
      }
    }

    service.sessions.set('session-a', makeSession('session-a'))
    service.sessions.set('session-b', makeSession('session-b'))

    await service.stopAllSessionsAndWait(500)

    expect(killed.sort()).toEqual(['session-a', 'session-b'])
    expect(drained.sort()).toEqual(['session-a', 'session-b'])
    expect(service.getActiveSessions()).toEqual([])
  })

  test('default CLI shutdown wait covers the CLI graceful cleanup budget', () => {
    expect(DESKTOP_CLI_GRACEFUL_SHUTDOWN_TIMEOUT_MS).toBeGreaterThanOrEqual(6_000)
  })
})

function sanitizeMemoryPath(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '-')
}
