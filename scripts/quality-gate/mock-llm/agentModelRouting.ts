import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildProviderManagedEnv } from '../../../src/server/services/providerRuntimeEnv'
import { createQualityGateSandbox } from '../sandbox'
import { startMockLlmServer } from './server'
import type { MockReply, MockRequest } from './scriptedModel'

const FLASH = 'deepseek-v4-flash'
const PRO = 'deepseek-v4-pro'
const AGENT_TYPE = 'routing-fixture'
const STEP_TIMEOUT_MS = 60_000

export function isExpectedRoutingCliExit(exitCode: number, signalCode: string | null, stoppedTeammate: boolean) {
  // The CLI handles SIGTERM with gracefulShutdown(143). Depending on whether
  // that handler runs, Bun reports a normal exit (143, null) or SIGTERM.
  return exitCode === 0 || (stoppedTeammate && (
    signalCode === 'SIGTERM' || (signalCode === null && exitCode === 143)
  ))
}

type RoutingCase = {
  id: string
  teammate?: boolean
  parentModel?: string
  builtIn?: boolean
  manualOverride?: string
  presetModel?: string
  toolModel?: 'opus'
  opusModel: string
  expectedModel: string
}

const routingCases: RoutingCase[] = [
  { id: 'saved-claude-preset', presetModel: 'claude-opus-4-8', opusModel: FLASH, expectedModel: FLASH },
  { id: 'mapped-tool-alias', toolModel: 'opus', opusModel: FLASH, expectedModel: FLASH },
  { id: 'automatic-tool-alias', toolModel: 'opus', opusModel: PRO, expectedModel: FLASH },
  { id: 'explicit-provider-preset', presetModel: PRO, opusModel: PRO, expectedModel: PRO },
  { id: 'explicit-preset-over-tool-alias', presetModel: PRO, toolModel: 'opus', opusModel: FLASH, expectedModel: PRO },
  { id: 'built-in-default', builtIn: true, opusModel: PRO, expectedModel: FLASH },
  { id: 'built-in-manual-override', builtIn: true, manualOverride: PRO, toolModel: 'opus', opusModel: FLASH, expectedModel: PRO },
  { id: 'teammate-manual-pro', teammate: true, builtIn: true, manualOverride: 'opus', opusModel: PRO, expectedModel: PRO },
  { id: 'teammate-manual-flash', teammate: true, builtIn: true, parentModel: PRO, manualOverride: 'haiku', opusModel: PRO, expectedModel: FLASH },
  { id: 'teammate-automatic-alias', teammate: true, toolModel: 'opus', opusModel: PRO, expectedModel: FLASH },
]

const textReply = (text: string): MockReply => ({
  kind: 'message', content: [{ type: 'text', text }], stopReason: 'end_turn',
})

/**
 * Exercise the real CLI, Agent tool, saved Agent model, and provider-managed env.
 * Only the loopback model is scripted. Each case gets an empty HOME and fake key;
 * neither provider state nor credentials are copied from the developer's machine.
 */
export async function runAgentModelRoutingScenario(rootDir: string, artifactDir: string) {
  mkdirSync(artifactDir, { recursive: true })
  const results: Array<{
    id: string
    expectedModel: string
    rootModels: Array<string | undefined>
    childModels: Array<string | undefined>
    status: 'passed' | 'failed'
    error?: string
  }> = []

  for (const testCase of routingCases) {
    const parentModel = testCase.parentModel ?? FLASH
    const sandbox = createQualityGateSandbox({
      label: `agent-model-${testCase.id}`,
      seedProviders: false,
      // Even the optional state fingerprint points at a disposable/nonexistent
      // path, so this offline reproduction never inspects real user config.
      sourceConfigDir: join(artifactDir, 'agent-model-routing-unused-config'),
      source: { PATH: process.env.PATH, SHELL: process.env.SHELL, SYSTEMROOT: process.env.SYSTEMROOT },
    })
    const workDir = join(sandbox.home, 'project')
    mkdirSync(workDir, { recursive: true })
    const agentType = testCase.builtIn ? 'statusline-setup' : AGENT_TYPE
    if (testCase.manualOverride) {
      mkdirSync(sandbox.configDir, { recursive: true })
      writeFileSync(join(sandbox.configDir, 'settings.json'), JSON.stringify({
        builtInAgentOverrides: { [agentType]: { model: testCase.manualOverride } },
      }))
    }
    const childMarker = `MODEL_ROUTING_CHILD_SYSTEM_${testCase.id}`
    const childReply = `MODEL_ROUTING_CHILD_DONE_${testCase.id}`
    const doneMarker = `MODEL_ROUTING_PARENT_DONE_${testCase.id}`
    const rootModels: Array<string | undefined> = []
    const childModels: Array<string | undefined> = []
    let emittedAgent = false
    let emittedTeam = false
    let receivedAgentResult = false
    let rootFinished = false
    let receivedRootResult = false
    let completedRootTurn = false
    const replyFor = (request: MockRequest): MockReply => {
      const last = request.messages?.at(-1)?.content
      const childPrompt = typeof last === 'string'
        ? last.includes(`${childMarker}_PROMPT`)
        : last?.some(block => block.type === 'text' && block.text?.includes(`${childMarker}_PROMPT`))
      if (JSON.stringify(request.system ?? '').includes(childMarker) || childPrompt) {
        childModels.push(request.model)
        if (rootFinished) completedRootTurn = true
        return textReply(childReply)
      }
      // Title/summary calls do not execute the Agent tool and are auxiliary.
      if (!request.tools?.some(tool => tool.name === 'Agent')) return textReply('Mock auxiliary reply')
      rootModels.push(request.model)
      if (testCase.teammate && !emittedTeam) {
        emittedTeam = true
        return {
          kind: 'message', content: [{ type: 'tool_use', id: 'routing_team_create', name: 'TeamCreate',
            input: { team_name: 'routing-fixture-team' } }], stopReason: 'tool_use',
        }
      }
      if (emittedAgent) {
        const lastContent = request.messages?.at(-1)?.content
        receivedAgentResult ||= Array.isArray(lastContent) && lastContent.some(block =>
          block.type === 'tool_result' && block.tool_use_id === 'model_routing_agent'
          && !block.is_error && JSON.stringify(block.content ?? '').includes(testCase.teammate ? 'Spawned successfully.' : childReply),
        )
        rootFinished = true
        completedRootTurn = !testCase.teammate || childModels.length > 0
        return textReply(doneMarker)
      }
      emittedAgent = true
      return {
        kind: 'message',
        content: [{
          type: 'tool_use', id: 'model_routing_agent', name: 'Agent',
          input: {
            subagent_type: agentType, description: 'Exercise the configured Agent model',
            prompt: `${childMarker}_PROMPT: Return the fixture completion marker.`,
            ...(testCase.teammate ? { name: 'routing-worker', team_name: 'routing-fixture-team' } : {}),
            ...(testCase.toolModel ? { model: testCase.toolModel } : {}),
          },
        }],
        stopReason: 'tool_use',
      }
    }
    const result: (typeof results)[number] = {
      id: testCase.id, expectedModel: testCase.expectedModel, rootModels, childModels, status: 'failed',
    }
    let upstream: ReturnType<typeof startMockLlmServer> | undefined
    try {
      upstream = startMockLlmServer(replyFor)
      const providerEnv = buildProviderManagedEnv({
        id: 'mock-deepseek', name: 'Mock DeepSeek', presetId: 'deepseek',
        baseUrl: upstream.url, apiKey: 'mock-agent-routing-key', apiFormat: 'anthropic',
        runtimeKind: 'anthropic_compatible',
        models: { main: parentModel, haiku: FLASH, sonnet: PRO, opus: testCase.opusModel },
      })
      const child = Bun.spawn([
        process.execPath, '--no-env-file', '--feature=TRANSCRIPT_CLASSIFIER', '--preload', join(rootDir, 'preload.ts'),
        join(rootDir, 'src/entrypoints/cli.tsx'),
        '--print', '--model', parentModel, '--permission-mode', 'bypassPermissions',
        ...(testCase.teammate ? ['--teammate-mode', 'in-process'] : []),
        '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--debug-file', join(artifactDir, `agent-model-routing-${testCase.id}.debug.log`),
        '--agents', JSON.stringify({
          [AGENT_TYPE]: {
            description: 'A deterministic model-routing fixture',
            prompt: `${childMarker}: Reply with the fixture completion marker.`,
            tools: ['Read'], ...(testCase.presetModel ? { model: testCase.presetModel } : {}),
          },
        }),
      ], {
        cwd: workDir, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
        env: {
          ...sandbox.env, ...providerEnv, CALLER_DIR: workDir, CC_HAHA_SKIP_DOTENV: '1',
          // CI's API-key-only auth check rejects DeepSeek's auth-token strategy.
          // This fixture deliberately exercises its actual managed auth env.
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
          ...(testCase.teammate ? { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } : {}),
        },
      })
      let timedOut = false
      let stoppedTeammate = false
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
          type: 'user', message: { role: 'user', content: 'Delegate this fixture to the routing-fixture Agent.' },
          parent_tool_use_id: null, session_id: '',
        })}\n`)
        child.stdin.flush()
        // SDK input stays open while the tool and its child are running. Closing
        // it immediately can end print mode before the first turn is consumed.
        while ((!completedRootTurn || !receivedRootResult) && child.exitCode === null && !timedOut) await Bun.sleep(50)
        child.stdin.end()
        // Teammates keep their inbox loop alive after EOF. Once both the parent
        // result and the outgoing child request are observed, stop this fixture.
        if (testCase.teammate && completedRootTurn && receivedRootResult && child.exitCode === null) {
          stoppedTeammate = true
          child.kill('SIGTERM')
        }
        const [exitCode, [stdout, stderr]] = await Promise.all([child.exited, output])
        writeFileSync(join(artifactDir, `agent-model-routing-${testCase.id}.log`), `${stdout}\n${stderr}`)
        assert.ok(!timedOut, `${testCase.id}: CLI exceeded ${STEP_TIMEOUT_MS}ms`)
        assert.ok(isExpectedRoutingCliExit(exitCode, child.signalCode, stoppedTeammate),
          `${testCase.id}: CLI failed (${exitCode}, ${child.signalCode}): ${stderr}\n${stdout}`)
        assert.ok(rootModels.length >= 2, `${testCase.id}: Agent result did not return to the root model`)
        assert.ok(rootModels.every(model => model === parentModel), `${testCase.id}: parent left ${parentModel}: ${rootModels}`)
        assert.ok(receivedAgentResult, `${testCase.id}: Agent failed or its result was not returned upstream`)
        assert.ok(receivedRootResult, `${testCase.id}: CLI did not report the completed parent turn`)
        assert.ok(stdout.includes(doneMarker), `${testCase.id}: CLI did not complete the root turn`)
        assert.ok(childModels.length > 0, `${testCase.id}: no child request reached the mock upstream`)
        assert.ok(childModels.every(model => model === testCase.expectedModel),
          `${testCase.id}: expected ${testCase.expectedModel}, outgoing child model was ${childModels.join(', ')}`)
        result.status = 'passed'
      } finally {
        clearTimeout(timer)
        // Also terminate on assertion, stream-reading, or stdin failures.
        if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error)
    } finally {
      try {
        await upstream?.stop()
      } finally {
        const mutations = sandbox.detectUserStateMutations()
        sandbox.cleanup()
        assert.deepEqual(mutations, [], 'model-routing lane mutated its isolated source state')
        results.push(result)
        writeFileSync(join(artifactDir, 'agent-model-routing-results.json'), `${JSON.stringify(results, null, 2)}\n`)
      }
    }
  }

  const failed = results.filter(result => result.status === 'failed')
  assert.equal(failed.length, 0, failed.map(result => `${result.id}: ${result.error}`).join('\n'))
  return results
}
