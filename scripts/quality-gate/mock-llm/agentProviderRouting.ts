import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildProviderManagedEnv } from '../../../src/server/services/providerRuntimeEnv'
import { createQualityGateSandbox } from '../sandbox'
import { isExpectedRoutingCliExit } from './agentModelRouting'
import { startMockLlmServer } from './server'
import type { MockReply, MockRequest } from './scriptedModel'

const SESSION_MODEL = 'session-main'
const AGENT_TYPE = 'provider-fixture'
const AGENT_PROVIDER_ID = 'agent-provider'
const STEP_TIMEOUT_MS = 60_000

type ProviderRoutingCase = {
  id: string
  /** Anthropic providers that opt out of nested media go through the provider proxy. */
  proxied: boolean
  agentModel: string
  effort: 'low' | 'max'
  expectedModel: string
  /** The session provider turns experimental betas (and effort) off for itself only. */
  sessionDisablesBetas?: boolean
}

const routingCases: ProviderRoutingCase[] = [
  { id: 'direct-alias-max', proxied: false, agentModel: 'haiku', effort: 'max', expectedModel: 'deepseek-v4-flash' },
  { id: 'proxied-concrete-low', proxied: true, agentModel: 'deepseek-v4-pro', effort: 'low', expectedModel: 'deepseek-v4-pro' },
  { id: 'session-betas-off', proxied: false, agentModel: 'haiku', effort: 'max', expectedModel: 'deepseek-v4-flash', sessionDisablesBetas: true },
]

const textReply = (text: string): MockReply => ({
  kind: 'message', content: [{ type: 'text', text }], stopReason: 'end_turn',
})

function mentions(request: MockRequest, marker: string) {
  return JSON.stringify(request.system ?? '').includes(marker) ||
    JSON.stringify(request.messages?.at(-1)?.content ?? '').includes(marker)
}

/**
 * A real CLI on session provider A delegates to an Agent pinned to saved
 * provider B. Only the two loopback models are scripted; the Agent's request
 * must leave A entirely and reach B with B's model slot and the saved effort.
 */
export async function runAgentProviderRoutingScenario(rootDir: string, artifactDir: string) {
  mkdirSync(artifactDir, { recursive: true })
  const results: Array<{ id: string; status: 'passed' | 'failed'; error?: string; agentRequests: unknown[] }> = []

  for (const testCase of routingCases) {
    const sandbox = createQualityGateSandbox({
      label: `agent-provider-${testCase.id}`,
      seedProviders: false,
      sourceConfigDir: join(artifactDir, 'agent-provider-routing-unused-config'),
      source: { PATH: process.env.PATH, SHELL: process.env.SHELL, SYSTEMROOT: process.env.SYSTEMROOT },
    })
    const workDir = join(sandbox.home, 'project')
    mkdirSync(workDir, { recursive: true })
    const childMarker = `PROVIDER_ROUTING_CHILD_${testCase.id}`
    const childReply = `PROVIDER_ROUTING_CHILD_DONE_${testCase.id}`
    const doneMarker = `PROVIDER_ROUTING_PARENT_DONE_${testCase.id}`
    const sessionChildRequests: MockRequest[] = []
    const agentRequests: Array<{ model?: string; effort?: unknown; path: string }> = []
    let emittedAgent = false
    let receivedAgentResult = false
    let rootFinished = false
    let receivedRootResult = false

    const sessionUpstream = startMockLlmServer((request: MockRequest): MockReply => {
      if (mentions(request, childMarker)) {
        sessionChildRequests.push(request)
        return textReply('WRONG_PROVIDER')
      }
      if (!request.tools?.some(tool => tool.name === 'Agent')) return textReply('Mock auxiliary reply')
      if (emittedAgent) {
        const last = request.messages?.at(-1)?.content
        receivedAgentResult ||= Array.isArray(last) && last.some(block =>
          block.type === 'tool_result' && block.tool_use_id === 'provider_routing_agent' &&
          !block.is_error && JSON.stringify(block.content ?? '').includes(childReply))
        rootFinished = true
        return textReply(doneMarker)
      }
      emittedAgent = true
      return {
        kind: 'message',
        content: [{
          type: 'tool_use', id: 'provider_routing_agent', name: 'Agent',
          input: {
            subagent_type: AGENT_TYPE, description: 'Exercise the pinned Agent provider',
            prompt: `${childMarker}_PROMPT: Return the fixture completion marker.`,
            // A tier alias from the lead names the session's slots; the pinned provider wins.
            model: 'opus',
          },
        }],
        stopReason: 'tool_use',
      }
    })
    const agentUpstream = startMockLlmServer((request: MockRequest): MockReply =>
      mentions(request, childMarker) ? textReply(childReply) : textReply('Mock auxiliary reply'))
    const result: (typeof results)[number] = { id: testCase.id, status: 'failed', agentRequests }

    try {
      mkdirSync(join(sandbox.configDir, 'cc-haha'), { recursive: true })
      writeFileSync(join(sandbox.configDir, 'cc-haha', 'providers.json'), JSON.stringify({
        schemaVersion: 4,
        activeId: null,
        providers: [{
          id: AGENT_PROVIDER_ID, presetId: 'deepseek', name: 'Agent provider',
          apiKey: 'mock-agent-provider-key', baseUrl: agentUpstream.url, apiFormat: 'anthropic',
          ...(testCase.proxied ? { supportsNestedToolResultMedia: false } : {}),
          models: { main: 'deepseek-v4-pro', haiku: 'deepseek-v4-flash', sonnet: 'deepseek-v4-pro', opus: 'deepseek-v4-pro' },
        }],
      }))
      // The session provider declares no effort capability for the Agent's
      // model, so the effort only survives if B's own capabilities are used.
      const sessionEnv = buildProviderManagedEnv({
        id: 'session-provider', name: 'Session provider', presetId: 'custom',
        baseUrl: sessionUpstream.url, apiKey: 'mock-session-key', apiFormat: 'anthropic',
        runtimeKind: 'anthropic_compatible',
        models: { main: SESSION_MODEL, haiku: SESSION_MODEL, sonnet: SESSION_MODEL, opus: SESSION_MODEL },
        ...(testCase.sessionDisablesBetas ? { disableExperimentalBetas: true } : {}),
      })
      const child = Bun.spawn([
        process.execPath, '--no-env-file', '--feature=TRANSCRIPT_CLASSIFIER', '--preload', join(rootDir, 'preload.ts'),
        join(rootDir, 'src/entrypoints/cli.tsx'),
        '--print', '--model', SESSION_MODEL, '--permission-mode', 'bypassPermissions',
        '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--debug-file', join(artifactDir, `agent-provider-routing-${testCase.id}.debug.log`),
        '--agents', JSON.stringify({
          [AGENT_TYPE]: {
            description: 'A deterministic provider-routing fixture',
            prompt: `${childMarker}: Reply with the fixture completion marker.`,
            tools: ['Read'], model: testCase.agentModel, provider: AGENT_PROVIDER_ID, effort: testCase.effort,
          },
        }),
      ], {
        cwd: workDir, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
        env: {
          ...sandbox.env, ...sessionEnv, CALLER_DIR: workDir, CC_HAHA_SKIP_DOTENV: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
        },
      })
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, STEP_TIMEOUT_MS)
      try {
        const readStdout = async () => {
          const decoder = new TextDecoder()
          let stdout = ''
          for await (const chunk of child.stdout) {
            stdout += decoder.decode(chunk, { stream: true })
            if (!receivedRootResult && stdout.includes(doneMarker)) {
              receivedRootResult = stdout.split('\n').some(line => {
                try {
                  const message = JSON.parse(line)
                  return message.type === 'result' && !message.is_error && message.result === doneMarker
                } catch { return false }
              })
            }
          }
          return stdout + decoder.decode()
        }
        const output = Promise.all([readStdout(), new Response(child.stderr).text()])
        child.stdin.write(`${JSON.stringify({
          type: 'user', message: { role: 'user', content: 'Delegate this fixture to the provider-fixture Agent.' },
          parent_tool_use_id: null, session_id: '',
        })}\n`)
        child.stdin.flush()
        while ((!rootFinished || !receivedRootResult) && child.exitCode === null && !timedOut) await Bun.sleep(50)
        child.stdin.end()
        const [exitCode, [stdout, stderr]] = await Promise.all([child.exited, output])
        writeFileSync(join(artifactDir, `agent-provider-routing-${testCase.id}.log`), `${stdout}\n${stderr}`)
        for (const request of agentUpstream.requests) {
          if (!mentions(request.body, childMarker)) continue
          agentRequests.push({
            model: request.body.model,
            effort: (request.body as { output_config?: { effort?: unknown } }).output_config?.effort,
            path: request.path,
          })
        }
        assert.ok(!timedOut, `${testCase.id}: CLI exceeded ${STEP_TIMEOUT_MS}ms`)
        assert.ok(isExpectedRoutingCliExit(exitCode, child.signalCode, false),
          `${testCase.id}: CLI failed (${exitCode}, ${child.signalCode}): ${stderr}\n${stdout}`)
        assert.ok(receivedAgentResult, `${testCase.id}: Agent failed or its result was not returned upstream`)
        assert.ok(receivedRootResult, `${testCase.id}: CLI did not report the completed parent turn`)
        assert.equal(sessionChildRequests.length, 0, `${testCase.id}: the Agent request reached the session provider`)
        assert.ok(agentRequests.length > 0, `${testCase.id}: no Agent request reached its pinned provider`)
        for (const request of agentRequests) {
          assert.equal(request.path, '/v1/messages')
          assert.equal(request.model, testCase.expectedModel, `${testCase.id}: wrong Agent model`)
          assert.equal(request.effort, testCase.effort, `${testCase.id}: the saved Agent effort did not reach its provider`)
        }
        assert.ok(agentUpstream.requests.every(request => request.body.model !== SESSION_MODEL),
          `${testCase.id}: a session request reached the Agent provider`)
        result.status = 'passed'
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error)
    } finally {
      try {
        await Promise.all([sessionUpstream.stop(), agentUpstream.stop()])
      } finally {
        const mutations = sandbox.detectUserStateMutations()
        sandbox.cleanup()
        assert.deepEqual(mutations, [], 'provider-routing lane mutated its isolated source state')
        results.push(result)
        writeFileSync(join(artifactDir, 'agent-provider-routing-results.json'), `${JSON.stringify(results, null, 2)}\n`)
      }
    }
  }

  const failed = results.filter(result => result.status === 'failed')
  assert.equal(failed.length, 0, failed.map(result => `${result.id}: ${result.error}`).join('\n'))
  return results
}
