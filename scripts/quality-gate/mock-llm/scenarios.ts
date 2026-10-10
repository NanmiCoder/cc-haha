/**
 * Scenarios only a scripted model can assert deterministically.
 *
 * The shared live catalog checks what a user sees. These add what only the upstream
 * side can see — what the CLI actually sent back to the model after a tool ran — and
 * the failure paths a real provider cannot be made to produce on demand.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { LiveScenarioRunner } from '../agent-flow/live'
import { LIVE_AGENT_FLOW_SCENARIOS } from '../agent-flow/liveScenarios'
import type { RecordedRequest } from './server'
import { UPSTREAM_ERROR_TRIGGER } from './scriptedModel'

export type MockAgentScenario = { id: string; title: string }

export const MOCK_ONLY_SCENARIOS: readonly MockAgentScenario[] = [
  {
    id: 'mock-tool-result-roundtrip',
    title: 'A shell tool runs for real and its output goes back to the model',
  },
  {
    id: 'mock-denied-tool-reaches-model',
    title: 'A denied tool call reaches the model as an error result',
  },
  {
    id: 'mock-interrupt-closes-upstream',
    title: 'Stopping a streaming reply closes the upstream connection instead of letting it run on',
  },
  {
    id: 'mock-upstream-error-recovers',
    title: 'An upstream error ends the turn visibly and the next turn still works',
  },
]

/** Every live scenario plus the mock-only ones. */
export const MOCK_AGENT_SCENARIOS: readonly MockAgentScenario[] = [
  ...LIVE_AGENT_FLOW_SCENARIOS.map(({ id, title }) => ({ id, title })),
  ...MOCK_ONLY_SCENARIOS,
]

type ToolResultBlock = { type: 'tool_result'; content?: unknown; is_error?: boolean }

/** tool_result blocks the CLI sent upstream after `since`. */
export function toolResultsSentUpstream(requests: readonly RecordedRequest[], since = 0): ToolResultBlock[] {
  const found: ToolResultBlock[] = []
  for (const request of requests.slice(since)) {
    const messages = request.body.messages ?? []
    const last = messages[messages.length - 1]
    if (last?.role !== 'user' || !Array.isArray(last.content)) continue
    for (const block of last.content) {
      if (block.type === 'tool_result') found.push(block as ToolResultBlock)
    }
  }
  return found
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((block) => (block && typeof block === 'object' && 'text' in block ? String(block.text) : '')).join('')
  }
  return ''
}

function streamedText(messages: ReadonlyArray<{ type: string; text?: unknown }>) {
  return messages.filter((message) => message.type === 'content_delta').map((message) => String(message.text ?? '')).join('')
}

export function createMockOnlyRunners(requests: readonly RecordedRequest[]): Record<string, LiveScenarioRunner> {
  return {
    async 'mock-tool-result-roundtrip'(ctx) {
      const nonce = `nonce-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const socket = await ctx.openSocket(await ctx.createSession())
      try {
        ctx.pinRuntime(socket)
        const start = socket.messages.length
        const upstreamStart = requests.length
        socket.send({ type: 'user_message', content: `Run the shell command \`echo ${nonce}\` and tell me what it printed.` })

        // Whether `echo` needs approval is the permission engine's call, not this
        // scenario's; approve if asked so the run does not depend on that policy.
        const settled = await socket.waitFor(
          (message) => message.type === 'permission_request' || message.type === 'message_complete',
          ctx.stepTimeoutMs,
          'permission_request or message_complete',
          start,
        )
        if (settled.type === 'permission_request') {
          socket.send({ type: 'permission_response', requestId: settled.requestId, allowed: true, rule: 'agent-flow-mock' })
          await socket.waitFor((m) => m.type === 'message_complete', ctx.stepTimeoutMs, 'message_complete', start)
        }

        const results = toolResultsSentUpstream(requests, upstreamStart)
        const echoed = results.find((block) => contentText(block.content).includes(nonce))
        if (!echoed) {
          throw new Error(`the model never received the command output; tool_results sent upstream: ${JSON.stringify(results)}`)
        }
        if (echoed.is_error) throw new Error('the command output came back flagged as an error')
        if (!streamedText(socket.messages.slice(start)).includes(nonce)) {
          throw new Error('the model\'s reply quoting the output never streamed to the client')
        }
      } finally {
        socket.close()
      }
    },

    async 'mock-denied-tool-reaches-model'(ctx) {
      const socket = await ctx.openSocket(await ctx.createSession())
      const target = join(ctx.workRoot, 'mock-denied.txt')
      try {
        ctx.pinRuntime(socket)
        const start = socket.messages.length
        const upstreamStart = requests.length
        socket.send({
          type: 'user_message',
          content: 'Create a file called mock-denied.txt in the current directory containing the word DENIED. Use your file writing tool, then stop.',
        })
        const request = await socket.waitFor((m) => m.type === 'permission_request', ctx.stepTimeoutMs, 'permission_request', start)
        socket.send({ type: 'permission_response', requestId: request.requestId, allowed: false, rule: 'agent-flow-mock' })
        await socket.waitFor((m) => m.type === 'message_complete', ctx.stepTimeoutMs, 'message_complete', start)

        if (existsSync(target)) throw new Error('a denied write still reached the disk')
        const results = toolResultsSentUpstream(requests, upstreamStart)
        if (!results.some((block) => block.is_error === true)) {
          throw new Error(`the denial never reached the model as an error tool_result; saw ${JSON.stringify(results)}`)
        }
      } finally {
        socket.close()
      }
    },

    async 'mock-interrupt-closes-upstream'(ctx) {
      const socket = await ctx.openSocket(await ctx.createSession())
      try {
        ctx.pinRuntime(socket)
        const start = socket.messages.length
        const upstreamStart = requests.length
        // 300 lines at the scripted model's pace stream for ~12s, far longer than the
        // stop below needs. A stop that only hides the stream lets it run to the end.
        socket.send({ type: 'user_message', content: 'Count from 1 to 300, writing each number on its own line. Do not stop early.' })
        await socket.waitFor((m) => m.type === 'content_delta', ctx.stepTimeoutMs, 'first content_delta', start)
        const stream = requests.slice(upstreamStart).find((request) => request.stream && (request.body.tools ?? []).length > 0)
        if (!stream) throw new Error('the counting turn never reached the upstream')

        socket.send({ type: 'stop_generation' })
        const deadline = Date.now() + 5_000
        while (stream.outcome === 'pending' && Date.now() < deadline) await Bun.sleep(50)
        if (stream.outcome !== 'cancelled') {
          throw new Error(`5s after stop the upstream stream was still ${stream.outcome}, not cancelled`)
        }
      } finally {
        socket.close()
      }
    },

    async 'mock-upstream-error-recovers'(ctx) {
      const socket = await ctx.openSocket(await ctx.createSession())
      try {
        ctx.pinRuntime(socket)
        const start = socket.messages.length
        socket.send({ type: 'user_message', content: `${UPSTREAM_ERROR_TRIGGER}: this request should fail upstream.` })
        const failure = await socket.waitFor(
          (m) => m.type === 'error' || (m.type === 'message_complete' && streamedText(socket.messages.slice(start)).length === 0),
          ctx.stepTimeoutMs,
          'an error frame for the failed turn',
          start,
        )
        if (failure.type !== 'error') {
          throw new Error('the failed turn completed silently with no error shown to the user')
        }
        // Let the failed turn finish settling before the next prompt.
        await socket.waitFor(
          (m) => m.type === 'message_complete' || (m.type === 'session_state_changed' && m.state === 'idle'),
          ctx.stepTimeoutMs,
          'failed turn to settle',
          start,
        ).catch(() => undefined)

        const next = socket.messages.length
        socket.send({ type: 'user_message', content: 'Reply with one short sentence.' })
        await socket.waitFor((m) => m.type === 'message_complete', ctx.stepTimeoutMs, 'message_complete after an upstream error', next)
        if (!streamedText(socket.messages.slice(next)).trim()) {
          throw new Error('the session did not answer again after an upstream error')
        }
      } finally {
        socket.close()
      }
    },
  }
}

/** Upstream request log written next to the run's other artifacts. */
export function describeRequests(requests: readonly RecordedRequest[]) {
  return requests.map((request) => ({
    path: request.path,
    stream: request.stream,
    model: request.body.model,
    tools: (request.body.tools ?? []).length,
    lastRole: request.body.messages?.[request.body.messages.length - 1]?.role,
    outcome: request.outcome,
  }))
}
