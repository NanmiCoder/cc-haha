/**
 * Scenarios only a scripted model can assert deterministically.
 *
 * The shared live catalog checks what a user sees. These add what only the upstream
 * side can see — what the CLI actually sent back to the model after a tool ran — and
 * the failure paths a real provider cannot be made to produce on demand.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { LiveScenarioRunner } from '../agent-flow/live'
import { LIVE_AGENT_FLOW_SCENARIOS } from '../agent-flow/liveScenarios'
import { MOCK_IMAGE_PNG_BASE64, type MockLlmServer, type RecordedRequest } from './server'
import { UPSTREAM_ERROR_TRIGGER } from './scriptedModel'

export type MockAgentScenario = { id: string; title: string }

export const MOCK_ONLY_SCENARIOS: readonly MockAgentScenario[] = [
  {
    id: 'mock-image-provider-protocols',
    title: 'Configured image protocols generate and edit real files through the CLI and return their paths to the model',
  },
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
    id: 'mock-stop-question-compact-recovers',
    title: 'Cancel a question, compact with visible progress, reconnect, and complete another turn',
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

export function createMockOnlyRunners(
  requests: readonly RecordedRequest[],
  imageRequests: MockLlmServer['imageRequests'] = [],
): Record<string, LiveScenarioRunner> {
  return {
    async 'mock-image-provider-protocols'(ctx) {
      const providerUrl = `${ctx.baseUrl}/api/providers/${ctx.target.providerId}`
      const originalResponse = await fetch(providerUrl)
      if (!originalResponse.ok) throw new Error(`reading the original image provider failed: ${originalResponse.status}`)
      const { provider: original } = await originalResponse.json() as {
        provider: { baseUrl: string; imageGeneration?: Record<string, unknown> }
      }
      const updateProvider = async (body: Record<string, unknown>) => {
        const response = await fetch(providerUrl, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!response.ok) throw new Error(`updating the image provider failed: ${response.status}`)
      }
      try {
        for (const { protocol, model, resolution } of [
          { protocol: 'openai_images', model: 'mock-image', resolution: '2k' },
          { protocol: 'gemini_native', model: 'mock-image', resolution: '2k' },
          { protocol: 'gemini_native', model: 'gemini-3.1-flash-lite-image', resolution: '1k' },
          { protocol: 'xai_images', model: 'mock-image', resolution: '2k' },
        ]) {
          await updateProvider({
            baseUrl: protocol === 'gemini_native'
              ? `${ctx.target.host.replace(/\/+$/, '')}/v1beta/openai/`
              : original.baseUrl,
            imageGeneration: { protocol, model, baseUrl: '', apiKey: 'mock-image-key' },
          })
          const socket = await ctx.openSocket(await ctx.createSession())
          try {
            ctx.pinRuntime(socket)
            let source: string | undefined
            for (const edit of [false, true]) {
              const start = socket.messages.length
              const upstreamStart = requests.length
              const imageStart = imageRequests.length
              socket.send({ type: 'user_message', content: edit ? `MOCK_IMAGE_EDIT ${JSON.stringify(source)}` : 'MOCK_IMAGE_GENERATE' })
              await socket.waitFor(m => m.type === 'message_complete', ctx.stepTimeoutMs, 'image turn completion', start)
              const results = toolResultsSentUpstream(requests, upstreamStart)
              const result = results.map(block => {
                try { return JSON.parse(contentText(block.content)) } catch { return null }
              }).find(value => value?.type === 'image_generation_result')
              if (!result) throw new Error(`${protocol} ${edit ? 'edit' : 'generate'} returned no image artifact to the model: ${JSON.stringify(results)}`)
              if (result.model !== model) throw new Error('the configured image model was not preserved')
              const image = result.images?.[0]
              if (!image?.path || image.mimeType !== 'image/png' || !existsSync(image.path)) throw new Error('image artifact is missing or has the wrong MIME')
              if (!readFileSync(image.path).equals(Buffer.from(MOCK_IMAGE_PNG_BASE64, 'base64'))) throw new Error('saved image bytes differ from the fixture')
              if (result.operation !== (edit ? 'edit' : 'generate') || result.inputImageCount !== (edit ? 1 : 0)) throw new Error('image edit inputs were not preserved')
              if (imageRequests.length !== imageStart + 1) throw new Error('image generation was retried or never reached the configured endpoint')
              const imageRequest = imageRequests[imageStart]!
              const expectedPath = protocol === 'gemini_native'
                ? `/v1beta/models/${model}:generateContent`
                : `/v1/images/${edit ? 'edits' : 'generations'}`
              if (imageRequest.path !== expectedPath) throw new Error(`image request used the wrong protocol endpoint: ${imageRequest.path}`)
              if (protocol === 'gemini_native') {
                if (!requests.slice(upstreamStart).some(request => request.path === '/v1beta/openai/v1/messages')) throw new Error('the Gemini image provider did not inherit the configured chat base URL')
                const body = imageRequest.body as {
                  generationConfig?: { imageConfig?: { aspectRatio?: string; imageSize?: string } }
                  contents?: Array<{ parts?: Array<{ inlineData?: { data?: string } }> }>
                }
                if (body.generationConfig?.imageConfig?.aspectRatio !== '4:5') throw new Error('the Gemini-only ratio did not reach the native image request')
                if (body.generationConfig?.imageConfig?.imageSize !== resolution.toUpperCase()) throw new Error('the supported Gemini resolution did not reach the native image request')
                if (edit && body.contents?.[0]?.parts?.[1]?.inlineData?.data !== MOCK_IMAGE_PNG_BASE64) throw new Error('the generated image bytes did not reach the native edit request')
              } else {
                const ratioOrSize = protocol === 'xai_images' ? imageRequest.body.aspect_ratio : imageRequest.body.size
                if (ratioOrSize !== (protocol === 'xai_images' ? '16:9' : '1536x1024')) throw new Error('the ordinary image protocol did not preserve its 16:9 ratio')
                if (protocol === 'xai_images' && imageRequest.body.resolution !== resolution) throw new Error('the xAI image protocol did not preserve its resolution')
              }
              if (!streamedText(socket.messages.slice(start)).includes(image.path)) throw new Error('image path never reached the client')
              source = image.path
            }
          } finally {
            socket.close()
          }
        }
      } finally {
        await updateProvider({ baseUrl: original.baseUrl, imageGeneration: original.imageGeneration ?? null })
      }
    },
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

    async 'mock-stop-question-compact-recovers'(ctx) {
      const sessionId = await ctx.createSession()
      let socket = await ctx.openSocket(sessionId)
      try {
        ctx.pinRuntime(socket)
        const seed = socket.messages.length
        socket.send({ type: 'user_message', content: 'Reply with one short sentence.' })
        await socket.waitFor(m => m.type === 'message_complete', ctx.stepTimeoutMs, 'seed completion', seed)
        const questionStart = socket.messages.length
        socket.send({ type: 'user_message', content: 'MOCK_ASK_BEFORE_COMPACT: ask me to choose A or B.' })
        await socket.waitFor(m => m.type === 'permission_request' && m.toolName === 'AskUserQuestion',
          ctx.stepTimeoutMs, 'pending AskUserQuestion', questionStart)
        const stopStart = socket.messages.length
        socket.send({ type: 'stop_generation' })
        await socket.waitFor(m => m.type === 'message_complete', ctx.stepTimeoutMs, 'interrupted result', stopStart)
        const compactStart = socket.messages.length
        socket.send({ type: 'user_message', content: '/compact' })
        const progress = await socket.waitFor(m => m.type === 'status' && m.state === 'compacting' &&
          Number((m.compactProgress as { outputChars?: number } | undefined)?.outputChars) > 0,
        ctx.stepTimeoutMs, 'compact output progress after Stop', compactStart)
        const firstOutputChars = Number((progress.compactProgress as { outputChars: number }).outputChars)
        await socket.waitFor(m => m.type === 'status' && m.state === 'compacting' &&
          Number((m.compactProgress as { outputChars?: number } | undefined)?.outputChars) > firstOutputChars,
        ctx.stepTimeoutMs, 'increasing compact output progress after Stop', compactStart)
        await socket.waitFor(m => m.type === 'system_notification' && m.subtype === 'compact_boundary',
          ctx.stepTimeoutMs, 'compact boundary after Stop', compactStart)
        await socket.waitFor(m => m.type === 'message_complete', ctx.stepTimeoutMs, 'compact completion after Stop', compactStart)
        socket.close()
        socket = await ctx.openSocket(sessionId)
        const nextStart = socket.messages.length
        socket.send({ type: 'user_message', content: 'Reply with one short sentence after compact.' })
        await socket.waitFor(m => m.type === 'message_complete', ctx.stepTimeoutMs, 'next turn after reconnect', nextStart)
        if (!streamedText(socket.messages.slice(nextStart)).trim()) throw new Error('no reply after compact and reconnect')
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
