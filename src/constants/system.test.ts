import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import semver from 'semver'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import { getIsInteractive, setIsInteractive } from '../bootstrap/state.js'
import { enableConfigs } from '../utils/config.js'
import { sideQuery } from '../utils/sideQuery.js'
import {
  CLAUDE_CODE_COMPAT_VERSION,
  CLAUDE_CODE_WIRE_ENTRYPOINT,
  formatClaudeCodeBillingHeader,
} from './claudeCodeCompatibility.js'
import { getAttributionHeader } from './system.js'

function withEntrypoint<T>(value: string | undefined, run: () => T): T {
  const original = process.env.CLAUDE_CODE_ENTRYPOINT
  if (value === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT
  else process.env.CLAUDE_CODE_ENTRYPOINT = value
  try {
    return run()
  } finally {
    if (original === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT
    else process.env.CLAUDE_CODE_ENTRYPOINT = original
  }
}

describe('getAttributionHeader', () => {
  test('tracks the audited upstream Claude Code compatibility release', () => {
    expect(CLAUDE_CODE_COMPAT_VERSION).toBe('2.1.321')
  })

  test('uses Claude Code compatibility version and always includes CCH placeholder', () => {
    expect(formatClaudeCodeBillingHeader({ fingerprint: 'abc' })).toBe(
      'x-anthropic-billing-header: cc_version=2.1.321.abc; cc_entrypoint=cli; cch=00000;',
    )
    withEntrypoint('cli', () => {
      expect(getAttributionHeader('abc')).toBe(
        'x-anthropic-billing-header: cc_version=2.1.321.abc; cc_entrypoint=cli; cch=00000;',
      )
    })
  })

  test('reports the CLI entrypoint upstream even when the host sets claude-desktop', () => {
    // CLAUDE_CODE_ENTRYPOINT=claude-desktop is an internal switch for the
    // desktop host; it must not leak into the billing header.
    expect(CLAUDE_CODE_WIRE_ENTRYPOINT).toBe('cli')
    for (const hostValue of ['claude-desktop', 'sdk-cli', undefined]) {
      withEntrypoint(hostValue, () => {
        expect(getAttributionHeader('abc')).toContain('cc_entrypoint=cli;')
      })
    }
  })

  test('sends Claude Code >= 2.1.290 wire headers required by claude-fable-5-2', async () => {
    expect(semver.gte(CLAUDE_CODE_COMPAT_VERSION, '2.1.290')).toBe(true)

    const requests: Array<Record<string, unknown>> = []
    const userAgents: Array<string | null> = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const userAgent = request.headers.get('user-agent')
        userAgents.push(userAgent)
        const body = (await request.json()) as Record<string, unknown>
        requests.push(body)

        const uaVersion = userAgent?.match(/^claude-cli\/(\d+\.\d+\.\d+)\b/)?.[1]
        const billingMatch = JSON.stringify(body.system).match(
          /x-anthropic-billing-header: cc_version=(\d+\.\d+\.\d+)\.[0-9a-f]+; cc_entrypoint=cli; cch=([0-9a-f]{5});/,
        )
        const ccVersion = billingMatch?.[1]
        const reported = !uaVersion || semver.lt(uaVersion, '2.1.290') ? uaVersion : ccVersion
        if (!uaVersion || !ccVersion || semver.lt(uaVersion, '2.1.290') || semver.lt(ccVersion, '2.1.290')) {
          return Response.json(
            {
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: `Claude Code ${reported ?? 'unknown'} does not support this model; version 2.1.290 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.`,
              },
            },
            { status: 400 },
          )
        }

        return Response.json({
          id: 'msg_fable_52_wire',
          type: 'message',
          role: 'assistant',
          model: 'claude-fable-5-2',
          content: [{ type: 'text', text: 'OK' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      },
    })

    const sandbox = await mkdtemp(join(tmpdir(), 'cc-haha-fable52-compat-'))
    const originalEnv = { ...process.env }
    const interactive = getIsInteractive()
    try {
      for (const key of Object.keys(process.env)) delete process.env[key]
      Object.assign(
        process.env,
        createSandboxedTestEnvironment(
          sandbox,
          {
            NODE_ENV: 'production',
            ANTHROPIC_API_KEY: 'loopback-test-key',
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
            ANTHROPIC_MODEL: 'claude-fable-5-2',
            CLAUDE_CODE_ATTRIBUTION_HEADER: '1',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          },
          originalEnv,
        ),
      )
      setIsInteractive(false)
      enableConfigs()

      const response = await sideQuery({
        model: 'claude-fable-5-2',
        messages: [{ role: 'user', content: 'Return OK' }],
        max_tokens: 64,
        querySource: 'fable_52_wire_compat',
      })

      expect(response.content).toEqual([{ type: 'text', text: 'OK' }])
      expect(requests).toHaveLength(1)
      expect(requests[0]?.model).toBe('claude-fable-5-2')
      expect(userAgents[0]).toBe(`claude-cli/${CLAUDE_CODE_COMPAT_VERSION} (external, cli)`)

      const systemJson = JSON.stringify(requests[0]?.system)
      const billingMatch = systemJson.match(
        /x-anthropic-billing-header: cc_version=(\d+\.\d+\.\d+)\.[0-9a-f]+; cc_entrypoint=cli; cch=([0-9a-f]{5});/,
      )
      expect(billingMatch?.[1]).toBe(CLAUDE_CODE_COMPAT_VERSION)
      expect(semver.gte(billingMatch?.[1] ?? '0.0.0', '2.1.290')).toBe(true)
      expect(billingMatch?.[2]).not.toBe('00000')
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key]
      Object.assign(process.env, originalEnv)
      setIsInteractive(interactive)
      server.stop(true)
      await rm(sandbox, { recursive: true, force: true })
    }
  })
})
