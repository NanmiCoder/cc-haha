import { describe, expect, test } from 'bun:test'
import type { DiagnosticEvent } from './diagnosticsService.js'
import {
  buildDiagnosticsIssueReport,
  projectDiagnosticEventForSharing,
} from './diagnosticsShare.js'

describe('projectDiagnosticEventForSharing', () => {
  test('reduces native and serialized errors to metadata without messages, stacks, paths, prompts, or cloud keys', () => {
    const nativeError = new Error('PRIVATE_PROMPT at /Users/alice/private/project AKIAIOSFODNN7EXAMPLE')
    nativeError.name = 'PRIVATE_PROMPT_CONTENT'
    nativeError.stack = 'ProviderRequestError: PRIVATE_STACK\n at /Users/alice/private/project/index.ts:42:1'
    const event: DiagnosticEvent = {
      id: 'event-AKIAIOSFODNN7EXAMPLE',
      timestamp: '2026-07-11T09:10:11.000Z',
      type: 'provider_error',
      severity: 'error',
      summary: 'PRIVATE_SUMMARY',
      sessionId: '/Users/alice/private/session',
      details: {
        nativeError,
        serializedError: {
          name: 'PRIVATE_SERIALIZED_ERROR_NAME',
          message: 'PRIVATE_SERIALIZED_MESSAGE wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          stack: 'PRIVATE_SERIALIZED_STACK /home/alice/private.txt',
        },
      },
    }

    const projected = projectDiagnosticEventForSharing(event)
    const serialized = JSON.stringify(projected)

    expect(projected.details).toEqual({
      nativeError: { name: 'UnknownError' },
      serializedError: { name: 'UnknownError' },
    })
    for (const privateValue of [
      'PRIVATE_PROMPT',
      'PRIVATE_STACK',
      'PRIVATE_SERIALIZED_MESSAGE',
      'PRIVATE_SERIALIZED_STACK',
      'PRIVATE_PROMPT_CONTENT',
      'PRIVATE_SERIALIZED_ERROR_NAME',
      '/Users/alice',
      '/home/alice',
      'AKIAIOSFODNN7EXAMPLE',
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
    expect(projected.omittedFields).toContain('details.nativeError.message')
    expect(projected.omittedFields).toContain('details.nativeError.stack')
    expect(projected.omittedFields).toContain('details.serializedError.message')
    expect(projected.omittedFields).toContain('details.serializedError.stack')
  })

  test('keeps diagnostic metadata while omitting content and personal data', () => {
    const error = new Error('request failed for sk-proj-PROJECTSECRET at user@example.com')
    const event: DiagnosticEvent = {
      id: 'event-share-safe-1',
      timestamp: '2026-07-11T09:10:11.000Z',
      type: 'sdk_result_error',
      severity: 'error',
      summary: 'PRIVATE_ASSISTANT_REPLY',
      sessionId: 'session-safe-id',
      details: {
        errorCode: 'CLI_START_FAILED',
        status: 'failed',
        content: 'PRIVATE_CONTENT',
        prompt: 'PRIVATE_PROMPT',
        response: 'PRIVATE_RESPONSE',
        capturedOutput: 'PRIVATE_CAPTURED_OUTPUT',
        sdkMessages: [{ message: { content: [{ type: 'text', text: 'PRIVATE_ASSISTANT_REPLY' }] } }],
        toolInput: 'PRIVATE_TOOL_INPUT',
        toolOutput: 'PRIVATE_TOOL_OUTPUT',
        assistantText: 'PRIVATE_ASSISTANT_TEXT',
        bareAnthropicToken: 'sk-ant-api03-BARESECRET',
        projectToken: 'sk-proj-PROJECTSECRET',
        githubToken: 'ghp_GITHUBSECRET',
        endpoint: 'https://private-user:private-pass@example.com/private/path?token=query-secret',
        email: 'user@example.com',
        error,
      },
    }

    const projected = projectDiagnosticEventForSharing(event)
    const serialized = JSON.stringify(projected)

    for (const privateValue of [
      'PRIVATE_CONTENT',
      'PRIVATE_PROMPT',
      'PRIVATE_RESPONSE',
      'PRIVATE_CAPTURED_OUTPUT',
      'PRIVATE_ASSISTANT_REPLY',
      'PRIVATE_TOOL_INPUT',
      'PRIVATE_TOOL_OUTPUT',
      'PRIVATE_ASSISTANT_TEXT',
      'sk-ant-api03-BARESECRET',
      'sk-proj-PROJECTSECRET',
      'ghp_GITHUBSECRET',
      'private-user',
      'private-pass',
      '/private/path',
      'query-secret',
      'user@example.com',
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
    expect(projected.id).toBe(event.id)
    expect(projected.type).toBe(event.type)
    expect(projected.severity).toBe(event.severity)
    expect(projected.details).toMatchObject({ errorCode: 'CLI_START_FAILED', status: 'failed' })
    expect(projected.omittedFields).toContain('summary')
    expect(projected.omittedFields).toContain('details.sdkMessages')
    expect(projected.omittedFields).toContain('details.error.message')
    expect(projected.omittedFields).toContain('details.error.stack')
  })

  test('keeps the failing API route and method so 4xx events are attributable', () => {
    const event: DiagnosticEvent = {
      id: 'event-api-failure',
      timestamp: '2026-07-11T09:10:11.000Z',
      type: 'client_api_request_failed',
      severity: 'warn',
      summary: 'GET /api/sessions/... failed',
      details: {
        method: 'GET',
        path: '/api/sessions/f9312a1e-3fe0-42d5-8d2b-522a06146987/messages',
        status: 404,
      },
    }

    const projected = projectDiagnosticEventForSharing(event)

    expect(projected.details).toEqual({
      method: 'GET',
      path: '/api/sessions/:id/messages',
      status: 404,
    })
    expect(JSON.stringify(projected)).not.toContain('f9312a1e')
    expect(projected.omittedFields).not.toContain('details.path')
    expect(projected.omittedFields).not.toContain('details.method')
  })

  test('replaces identifier-shaped route segments regardless of position', () => {
    const event: DiagnosticEvent = {
      id: 'event-api-ids',
      timestamp: '2026-07-11T09:10:11.000Z',
      type: 'client_api_request_failed',
      severity: 'warn',
      summary: 'ids',
      details: {
        path: '/api/projects/42/files/9f86d081884c7d659a2feaa0c55ad015/raw',
      },
    }

    expect(projectDiagnosticEventForSharing(event).details).toEqual({
      path: '/api/projects/:id/files/:id/raw',
    })
  })

  test('strips query strings and fragments while keeping the route', () => {
    for (const [path, expected] of [
      ['/api/files?token=query-secret', '/api/files'],
      ['/api/files#private-fragment', '/api/files'],
      ['/api/sessions/f9312a1e-3fe0-42d5-8d2b-522a06146987?token=secret', '/api/sessions/:id'],
    ] as const) {
      const projected = projectDiagnosticEventForSharing({
        id: 'event-api-query',
        timestamp: '2026-07-11T09:10:11.000Z',
        type: 'client_api_request_failed',
        severity: 'warn',
        summary: 'query',
        details: { path },
      })

      expect(projected.details?.path).toBe(expected)
      const serialized = JSON.stringify(projected)
      expect(serialized).not.toContain('query-secret')
      expect(serialized).not.toContain('private-fragment')
      expect(serialized).not.toContain('f9312a1e')
    }
  })

  test('omits paths that are not in-app API routes', () => {
    for (const path of [
      '/Users/alice/private/project/notes.md',
      '/home/alice/.ssh/id_rsa',
      '/api/files/%2Fetc%2Fpasswd',
      '/api/files/../../etc/passwd',
      'https://example.com/api/files',
      '//evil.example.com/api',
      `/api/${'deep/'.repeat(20)}leaf`,
    ]) {
      const projected = projectDiagnosticEventForSharing({
        id: 'event-api-unsafe',
        timestamp: '2026-07-11T09:10:11.000Z',
        type: 'client_api_request_failed',
        severity: 'warn',
        summary: 'unsafe',
        details: { path },
      })

      expect(projected.details?.path).toBeUndefined()
      expect(projected.omittedFields).toContain('details.path')
      expect(JSON.stringify(projected)).not.toContain('query-secret')
      expect(JSON.stringify(projected)).not.toContain('/Users/alice')
      expect(JSON.stringify(projected)).not.toContain('passwd')
    }
  })
})

describe('buildDiagnosticsIssueReport', () => {
  test('builds a deterministic share-safe GitHub issue template', () => {
    const report = buildDiagnosticsIssueReport({
      generatedAt: '2026-07-11T09:10:11.000Z',
      appInfo: {
        appVersion: '0.4.7',
        platform: 'darwin',
        arch: 'arm64',
        bun: '1.2.18',
        node: 'v22.17.0',
      },
      providersSummary: {
        activeId: 'provider-1',
        count: 1,
        providers: [{
          id: 'provider-1',
          name: 'Test Provider',
          apiFormat: 'anthropic',
          baseUrl: { hostname: 'api.example.com' },
          models: { main: 'main-model' },
        }],
      },
      events: [{
        id: 'event-report-1',
        timestamp: '2026-07-11T09:00:00.000Z',
        type: 'sdk_api_error',
        severity: 'error',
        details: {
          errorCode: 'API_ERROR',
          status: 'failed',
          content: 'PRIVATE_ASSISTANT_REPLY',
        },
        omittedFields: ['summary', 'details.sdkMessages'],
      }],
      corruptLineCount: 2,
    })

    expect(report).toContain('## 问题描述')
    expect(report).toContain('期望行为')
    expect(report).toContain('出现频率')
    expect(report).toContain('## 运行环境')
    expect(report).toContain('- App: 0.4.7')
    expect(report).toContain('- OS/Arch: darwin / arm64')
    expect(report).toContain('- Bun/Node: 1.2.18 / v22.17.0')
    expect(report).toContain('- 安装来源: <!-- 请补充 -->')
    expect(report).toContain('## Provider / 模型')
    expect(report).toContain('api.example.com')
    expect(report).toContain('main-model')
    expect(report).toContain('## 诊断关联')
    expect(report).toContain('- Event IDs: event-report-1')
    expect(report).toContain('- Corrupt diagnostic lines: 2')
    expect(report).toContain('检测到 2 行损坏的诊断记录')
    expect(report).toContain('## 复现步骤')
    expect(report).toContain('## 错误摘要')
    expect(report).toContain('2026-07-11T09:00:00.000Z')
    expect(report).not.toContain('PRIVATE_ASSISTANT_REPLY')
  })

  test('keeps ordinary model names readable but redacts secret-like model values', () => {
    const report = buildDiagnosticsIssueReport({
      generatedAt: '2026-07-11T09:10:11.000Z',
      appInfo: { appVersion: '0.4.7', platform: 'darwin', arch: 'arm64', bun: '1.2.18', node: 'v22.17.0' },
      providersSummary: {
        providers: [{
          id: 'provider-1',
          name: 'Test Provider',
          apiFormat: 'anthropic',
          baseUrl: { hostname: 'api.example.com' },
          models: {
            main: 'claude-sonnet-4',
            fallback: 'gpt-4o',
            leaked: 'sk-proj-LEAKEDMODELKEY',
          },
        }],
      },
      events: [],
      corruptLineCount: 0,
    })

    expect(report).toContain('claude-sonnet-4')
    expect(report).toContain('gpt-4o')
    expect(report).not.toContain('sk-proj-LEAKEDMODELKEY')
    expect(report).toContain('leaked=\\[REDACTED\\]')
  })

  test('keeps untrusted event and provider metadata from injecting Markdown or leaking secrets', () => {
    const extendedSecrets = [
      `AIza${'A'.repeat(35)}`,
      `gho_${'B'.repeat(36)}`,
      `ghr_${'C'.repeat(36)}`,
      'xoxb-1234567890-1234567890-abcdefghijkl',
    ]
    const report = buildDiagnosticsIssueReport({
      generatedAt: '2026-07-11T09:10:11.000Z -->\n## injected-generated',
      appInfo: {
        appVersion: '0.4.7\n## injected-app',
        platform: 'darwin',
        arch: 'arm64',
        bun: '1.2.18',
        node: 'v22.17.0',
      },
      providersSummary: {
        providers: [{
          id: 'provider-1',
          name: `[private provider](https://evil.example)\n## injected-provider sk-proj-PROVIDERSECRET ${extendedSecrets[0]} **bold** __underlined__ _italic_ @maintainer`,
          apiFormat: 'anthropic\n- [x] forged-provider-field',
          baseUrl: { hostname: 'api.example.com\n## injected-host' },
          models: {
            'main\n## injected-model-key': 'sk-ant-api03-MODELSECRET',
            oauth: extendedSecrets[1],
            refresh: extendedSecrets[2],
            slack: extendedSecrets[3],
          },
        }],
      },
      events: [{
        id: 'event-1\n## injected-event-id',
        timestamp: '2026-07-11T09:00:00.000Z\n## injected-timestamp',
        type: 'sdk_api_error\n## injected-event-type',
        severity: 'error',
        details: {
          errorCode: 'API_ERROR\n## injected-error-code',
          status: 'failed',
        },
        omittedFields: ['summary'],
      }],
      corruptLineCount: 0,
    })

    expect(report).not.toMatch(/\n## injected-/)
    expect(report).not.toContain('- [x] forged-provider-field')
    expect(report).not.toContain('](evil.example)')
    expect(report).not.toContain('sk-proj-PROVIDERSECRET')
    expect(report).not.toContain('sk-ant-api03-MODELSECRET')
    for (const secret of extendedSecrets) expect(report).not.toContain(secret)
    expect(report).not.toContain('**bold**')
    expect(report).not.toContain('__underlined__')
    expect(report).not.toContain('_italic_')
    expect(report).not.toContain('@maintainer')
  })
})
