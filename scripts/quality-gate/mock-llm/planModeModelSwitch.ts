import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { executeAgentFlowAgainstProvider } from '../agent-flow/live'
import type { SessionSocket } from '../agent-flow/execute'
import { startMockLlmServer } from './server'
import type { MockReply, MockRequest } from './scriptedModel'

const TIMEOUT_MS = 45_000
const PLAN_MODEL_A = 'mock-plan-model-a'
const PLAN_MODEL_B = 'mock-plan-model-b'
const EXEC_MODEL_C = 'mock-exec-model-c'

type ToolBlock = {
  type?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}

function blocks(request: MockRequest): ToolBlock[] {
  return (request.messages ?? []).flatMap((message) =>
    Array.isArray(message.content) ? (message.content as ToolBlock[]) : [],
  )
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content
  return Array.isArray(content)
    ? content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n')
    : ''
}

function exitPlanReply(request: MockRequest, id: string, planText: string): MockReply {
  const loaded = request.tools?.some((tool) => tool.name === 'ExitPlanMode')
  if (!loaded) {
    return {
      kind: 'message',
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: `${id}-search`, name: 'ToolSearch', input: { query: 'select:ExitPlanMode' } }],
    }
  }
  return {
    kind: 'message',
    stopReason: 'tool_use',
    content: [{ type: 'tool_use', id, name: 'ExitPlanMode', input: { plan: planText } }],
  }
}

export async function runPlanModeModelSwitchScenario(rootDir: string, artifactDir: string) {
  mkdirSync(artifactDir, { recursive: true })
  const seenModelsA: string[] = []
  const seenModelsB: string[] = []
  let revisionFeedbackSeen = false
  const sockets: SessionSocket[] = []

  const upstreamA = startMockLlmServer((request) => {
    if (!request.tools?.some((tool) => tool.name === 'Read' || tool.name === 'ToolSearch' || tool.name === 'ExitPlanMode')) {
      return { kind: 'message', content: [{ type: 'text', text: 'Auxiliary reply' }], stopReason: 'end_turn' }
    }
    seenModelsA.push(request.model)
    const allBlocks = blocks(request)
    const rejectedFirstPlan = allBlocks.find(
      (block) => block.type === 'tool_result' && block.tool_use_id === 'exit-plan-1',
    )
    if (rejectedFirstPlan) {
      const rejectionText = textContent(rejectedFirstPlan.content)
      if (rejectionText.includes('Include rollback verification')) {
        revisionFeedbackSeen = true
      }
      return exitPlanReply(request, 'exit-plan-2', '# Revised Plan\n1. Migrate\n2. Include rollback verification')
    }
    return exitPlanReply(request, 'exit-plan-1', '# Initial Plan\n1. Migrate')
  })

  const upstreamB = startMockLlmServer((request) => {
    if (!request.tools?.some((tool) => tool.name === 'Read' || tool.name === 'ToolSearch')) {
      return { kind: 'message', content: [{ type: 'text', text: 'Auxiliary reply B' }], stopReason: 'end_turn' }
    }
    seenModelsB.push(request.model)
    return {
      kind: 'message',
      content: [{ type: 'text', text: 'PLAN_EXECUTION_COMPLETED_ON_MODEL_C' }],
      stopReason: 'end_turn',
    }
  })

  let providerA = ''
  let providerB = ''

  try {
    const results = await executeAgentFlowAgainstProvider({
      rootDir,
      artifactDir,
      label: 'plan-mode-model-switch',
      seedProviders: false,
      stepTimeoutMs: TIMEOUT_MS,
      scenarios: [{ id: 'mock-plan-mode-model-switch', title: 'Plan mode model switch on keep planning and approve' }],
      async resolveTarget(server) {
        const register = async (name: string, baseUrl: string, apiKey: string, main: string, sonnet: string) => {
          const response = await fetch(`${server.baseUrl}/api/providers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              presetId: 'custom',
              name,
              baseUrl,
              apiKey,
              apiFormat: 'anthropic',
              authStrategy: 'api_key',
              models: { main, sonnet, haiku: main, opus: sonnet },
            }),
          })
          assert.equal(response.status, 201, await response.clone().text())
          const body = (await response.json()) as { provider?: { id?: string }; id?: string }
          const id = body.provider?.id ?? body.id
          assert.ok(id)
          return id
        }
        providerA = await register('Plan Provider A', upstreamA.url, 'mock-plan-key-a', PLAN_MODEL_A, PLAN_MODEL_B)
        providerB = await register('Plan Provider B', upstreamB.url, 'mock-plan-key-b', EXEC_MODEL_C, EXEC_MODEL_C)
        return {
          providerId: providerA,
          providerName: 'Plan Provider A',
          modelId: PLAN_MODEL_A,
          host: upstreamA.url,
          source: 'synthetic plan mode providers',
        }
      },
      runners: {
        async 'mock-plan-mode-model-switch'(ctx) {
          const sessionId = await ctx.createSession()
          const socket = await ctx.openSocket(sessionId)
          sockets.push(socket)
          ctx.pinRuntime(socket)
          socket.send({ type: 'set_permission_mode', mode: 'plan' })
          await socket.waitFor(
            (msg) => msg.type === 'permission_mode_changed' && msg.mode === 'plan',
            TIMEOUT_MS,
            'enter plan mode',
          )

          let cursor = socket.messages.length
          socket.send({ type: 'user_message', content: 'Draft a migration plan.' })

          const firstPlanReq = await socket.waitFor(
            (msg) => msg.type === 'permission_request' && msg.toolName === 'ExitPlanMode',
            TIMEOUT_MS,
            'initial ExitPlanMode request',
            cursor,
          )
          cursor = socket.messages.indexOf(firstPlanReq) + 1
          assert.ok(seenModelsA.length >= 1)
          assert.ok(seenModelsA.every((model) => model === PLAN_MODEL_A), `expected ${PLAN_MODEL_A}, got ${seenModelsA.join(',')}`)

          // 1. Keep planning with a same-provider model switch: must switch in-process
          // and run the immediate plan revision request on PLAN_MODEL_B.
          const countBeforeKeepPlanning = seenModelsA.length
          socket.send({
            type: 'permission_response',
            requestId: firstPlanReq.requestId,
            allowed: false,
            denyMessage: 'Include rollback verification.',
            runtimeOverride: {
              providerId: providerA,
              modelId: PLAN_MODEL_B,
            },
          })

          const secondPlanReq = await socket.waitFor(
            (msg) => msg.type === 'permission_request' && msg.toolName === 'ExitPlanMode',
            TIMEOUT_MS,
            'revised ExitPlanMode request on switched model',
            cursor,
          )
          cursor = socket.messages.indexOf(secondPlanReq) + 1
          const revisionModels = seenModelsA.slice(countBeforeKeepPlanning)
          assert.ok(revisionModels.length >= 1, 'expected revision LLM call after Keep planning')
          assert.ok(
            revisionModels.every((model) => model === PLAN_MODEL_B),
            `expected revision requests on ${PLAN_MODEL_B}, got ${revisionModels.join(',')}`,
          )
          assert.equal(revisionFeedbackSeen, true, 'expected revision feedback in ExitPlanMode tool_result')

          // 2. Approve plan with a cross-provider model switch: must restart onto
          // Provider B and execute on EXEC_MODEL_C.
          socket.send({
            type: 'permission_response',
            requestId: secondPlanReq.requestId,
            allowed: true,
            permissionUpdates: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }],
            runtimeOverride: {
              providerId: providerB,
              modelId: EXEC_MODEL_C,
            },
          })

          await socket.waitFor(
            (msg) =>
              msg.type === 'content_delta' &&
              typeof msg.text === 'string' &&
              msg.text.includes('PLAN_EXECUTION_COMPLETED_ON_MODEL_C'),
            TIMEOUT_MS,
            'execution output from cross-provider model C',
            cursor,
          )
          await socket.waitFor(
            (msg) => msg.type === 'message_complete' && seenModelsB.includes(EXEC_MODEL_C),
            TIMEOUT_MS,
            'execution message_complete on model C',
            cursor,
          )
          assert.ok(
            seenModelsB.every((model) => model === EXEC_MODEL_C),
            `expected execution requests on ${EXEC_MODEL_C}, got ${seenModelsB.join(',')}`,
          )
          return {
            detail: `planA=${seenModelsA.join('->')} execB=${seenModelsB.join('->')}`,
          }
        },
      },
    })

    writeFileSync(join(artifactDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
    const failed = results.find((entry) => entry.status === 'failed')
    if (failed) {
      throw new Error(failed.error ?? failed.detail ?? 'mock-plan-mode-model-switch failed')
    }
  } finally {
    for (const socket of sockets) socket.close()
    await upstreamA.stop()
    await upstreamB.stop()
  }
}
