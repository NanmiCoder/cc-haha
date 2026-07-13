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
})
