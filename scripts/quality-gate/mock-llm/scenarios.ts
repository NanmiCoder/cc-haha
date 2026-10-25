/**
 * Scenarios only a scripted model can assert deterministically.
 *
 * The shared live catalog checks what a user sees. These add what only the upstream
 * side can see — what the CLI actually sent back to the model after a tool ran — and
 * the failure paths a real provider cannot be made to produce on demand.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

import type { LiveScenarioRunner } from '../agent-flow/live'
import { LIVE_AGENT_FLOW_SCENARIOS } from '../agent-flow/liveScenarios'
import { MOCK_IMAGE_PNG_BASE64, type MockLlmServer, type RecordedRequest } from './server'
import { UPSTREAM_ERROR_TRIGGER, UPSTREAM_REFUSAL_TRIGGER } from './scriptedModel'

export type MockAgentScenario = { id: string; title: string }

export const MOCK_ONLY_SCENARIOS: readonly MockAgentScenario[] = [
  { id: 'mock-deepseek-web-search', title: 'DeepSeek standalone search returns summaries through the real CLI to the model' },
  { id: 'mock-mcp-late-reconnect', title: 'Reconnect a late-starting MCP service into an already running CLI session' },
  { id: 'mock-session-delegation-review', title: 'Real CLI yields for model allocation and starts a child only after UI confirmation' },
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
  {
    id: 'mock-provider-refusal-recovers',
    title: 'A third-party refusal names the selected model without changing provider and the next turn still works',
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
  searchRequests: MockLlmServer['searchRequests'] = [],
): Record<string, LiveScenarioRunner> {
  return {
    async 'mock-deepseek-web-search'(ctx) {
      const settingsUrl = `${ctx.baseUrl}/api/settings/user`
      const originalResponse = await fetch(settingsUrl)
      if (!originalResponse.ok) throw new Error('reading sandbox settings failed')
      const original = await originalResponse.json() as { webSearch?: unknown }
      const update = async (webSearch: unknown) => {
        const response = await fetch(settingsUrl, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ webSearch }),
        })
        if (!response.ok) throw new Error(`updating search settings failed: ${response.status}`)
      }
      await update({ mode: 'deepseek', deepseekApiKey: 'mock-deepseek-key' })
      const socket = await ctx.openSocket(await ctx.createSession())
      try {
        ctx.pinRuntime(socket)
        const since = requests.length
        const searchStart = searchRequests.length
        socket.send({ type: 'user_message', content: 'MOCK_DEEPSEEK_SEARCH' })
        const settled = await socket.waitFor(m => m.type === 'permission_request' || m.type === 'message_complete', ctx.stepTimeoutMs, 'DeepSeek search permission or completion')
        if (settled.type === 'permission_request') {
          socket.send({ type: 'permission_response', requestId: settled.requestId, allowed: true, rule: 'agent-flow-mock' })
          await socket.waitFor(m => m.type === 'message_complete', ctx.stepTimeoutMs, 'DeepSeek search completion')
        }
        const searches = searchRequests.slice(searchStart)
        if (searches.length !== 1) throw new Error(`expected one intercepted search, got ${searches.length}`)
        const search = searches[0]!
        if (search.headers.get('authorization') !== 'Bearer mock-deepseek-key') throw new Error('search did not use its own fake API key')
        if (search.body.query !== 'DeepSeek fixture' || search.body.count !== 8 || search.body.need_content !== false) throw new Error(`unexpected search request: ${JSON.stringify(search.body)}`)
        if (!toolResultsSentUpstream(requests, since).some(result => !result.is_error && contentText(result.content).includes('DEEPSEEK_SUMMARY_REACHED_MODEL'))) throw new Error('search summary did not reach the model')
        if (!streamedText(socket.messages).includes('DEEPSEEK_SUMMARY_REACHED_MODEL')) throw new Error('search summary did not reach the client')
      } finally {
        socket.close()
        await update(original.webSearch ?? { mode: 'auto' })
      }
    },
    async 'mock-mcp-late-reconnect'(ctx) {
      const cwd = realpathSync(ctx.workRoot)
      let ready = false
      let calls = 0
      let unavailableAttempts = 0
      const mcp = Bun.serve({
        hostname: '127.0.0.1', port: 0,
        async fetch(req) {
          if (!ready) {
            unavailableAttempts += 1
            return new Response('MCP application has not started', { status: 503 })
          }
          if (req.method !== 'POST') return new Response(null, { status: 405 })
          const request = await req.json() as { id?: number | string; method: string }
          if (request.id === undefined) return new Response(null, { status: 202 })
          let result: unknown
          if (request.method === 'initialize') {
            result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'late-fixture', version: '1' } }
          } else if (request.method === 'tools/list') {
            result = { tools: [{ name: 'echo', description: 'Return the late MCP fixture marker', inputSchema: { type: 'object', properties: {} } }] }
          } else if (request.method === 'tools/call') {
            calls += 1
            result = { content: [{ type: 'text', text: 'LATE_MCP_AVAILABLE' }] }
          } else {
            return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
          }
          return Response.json({ jsonrpc: '2.0', id: request.id, result })
        },
      })
      const name = 'late_start'
      let socket: Awaited<ReturnType<typeof ctx.openSocket>> | undefined
      let oldSocket: Awaited<ReturnType<typeof ctx.openSocket>> | undefined
      try {
        // Keep a CLI whose cached config predates this MCP alongside the CLI
        // that starts with the configured but unavailable service.
        oldSocket = await ctx.openSocket(await ctx.createSession())
        ctx.pinRuntime(oldSocket)
        oldSocket.send({ type: 'user_message', content: 'Reply with one short sentence.' })
        await oldSocket.waitFor(message => message.type === 'message_complete', ctx.stepTimeoutMs, 'turn before adding MCP config')
        const created = await fetch(`${ctx.baseUrl}/api/mcp`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd, name, scope: 'local', config: { type: 'http', url: `http://127.0.0.1:${mcp.port}/mcp` } }),
        })
        if (!created.ok) throw new Error(`creating the fixture MCP config failed: ${created.status}`)
        const sessionId = await ctx.createSession()
        socket = await ctx.openSocket(sessionId)
        ctx.pinRuntime(socket)
        socket.send({ type: 'user_message', content: 'Reply with one short sentence.' })
        await socket.waitFor(message => message.type === 'message_complete', ctx.stepTimeoutMs, 'initial turn without MCP')
        if (unavailableAttempts === 0) throw new Error('The CLI must attempt the configured MCP before the application starts')
        if (calls !== 0) throw new Error('The unavailable MCP must not execute a tool')
        ready = true
        const reconnected = await fetch(`${ctx.baseUrl}/api/mcp/${name}/reconnect`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd, sessionId }),
        })
        const receipt = await reconnected.json() as { sessionSync?: { applied: boolean }; server?: { status: string } }
        if (!reconnected.ok || receipt.server?.status !== 'connected' || !receipt.sessionSync?.applied) {
          throw new Error(`reconnect did not update the running conversation: ${JSON.stringify(receipt)}`)
        }
        for (const active of [oldSocket, socket]) {
          const since = requests.length
          const start = active.messages.length
          active.send({ type: 'user_message', content: 'MOCK_LATE_MCP' })
          const settled = await active.waitFor(message => message.type === 'permission_request' || message.type === 'message_complete', ctx.stepTimeoutMs, 'late MCP permission or completion', start)
          if (settled.type === 'permission_request') {
            active.send({ type: 'permission_response', requestId: settled.requestId, allowed: true, rule: 'agent-flow-mock' })
          }
          await active.waitFor(message => message.type === 'message_complete', ctx.stepTimeoutMs, 'late MCP tool call', start)
          const roundtrip = toolResultsSentUpstream(requests, since).some(result => contentText(result.content).includes('LATE_MCP_AVAILABLE') && !result.is_error)
          if (!roundtrip) throw new Error('Each reconnected CLI must return the actual MCP tool result to the model')
        }
        if (calls !== 2) throw new Error('Both reconnected CLIs must execute the MCP tool exactly once')
      } finally {
        socket?.close()
        oldSocket?.close()
        try {
          await fetch(`${ctx.baseUrl}/api/mcp/${name}?scope=local&cwd=${encodeURIComponent(cwd)}`, { method: 'DELETE' })
        } finally {
          mcp.stop(true)
        }
      }
    },
    async 'mock-session-delegation-review'(ctx) {
      const sessionId = await ctx.createSession()
      const socket = await ctx.openSocket(sessionId)
      const base = `${ctx.baseUrl}/api/session-collaboration/${sessionId}`
      const read = async () => {
        const response = await fetch(`${base}/delegation`)
        if (!response.ok) throw new Error(`delegation snapshot failed: ${response.status}`)
        return await response.json() as any
      }
      try {
        ctx.pinRuntime(socket)
        const start = socket.messages.length
        socket.send({ type: 'user_message', content: 'MOCK_SESSION_DELEGATION' })
        await socket.waitFor(message => message.type === 'message_complete', ctx.stepTimeoutMs, 'delegation review yield', start)
        const snapshot = await read()
        const batch = snapshot.batches.find((item: any) => item.requestId === 'mock-delegation')
        if (!batch || batch.state !== 'review' || batch.sessions.some((item: any) => item.sessionId)) throw new Error('The CLI must yield with a review card before any child exists')
        const response = await fetch(`${base}/batches/${encodeURIComponent(batch.id)}/confirm`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: batch.revision }),
        })
        const accepted = await response.json() as any
        if (!response.ok || !['launching', 'launched'].includes(accepted.state)) throw new Error(`confirm was not accepted: ${JSON.stringify(accepted)}`)
        // The UI request answers once the batch is launching; the child starts after it.
        const deadline = Date.now() + ctx.stepTimeoutMs
        let launched = accepted
        while (launched.state !== 'launched' && launched.state !== 'failed' && Date.now() < deadline) {
          await Bun.sleep(100)
          launched = (await read()).batches.find((item: any) => item.id === batch.id) ?? launched
        }
        if (launched.state !== 'launched' || !launched.sessions[0]?.sessionId) throw new Error(`confirm did not launch the child: ${JSON.stringify(launched)}`)
        const runtime = launched.sessions[0].runtime
        if (runtime.providerId !== ctx.target.providerId || runtime.modelId !== ctx.target.modelId) throw new Error('Child runtime did not preserve the selected provider and model')
        await fetch(`${base}/stop`, { method: 'POST' })
        const explicitId = await ctx.createSession()
        const explicitSocket = await ctx.openSocket(explicitId)
        try {
          ctx.pinRuntime(explicitSocket)
          explicitSocket.send({ type: 'user_message', content: `MOCK_SESSION_EXPLICIT ${JSON.stringify({ providerId: ctx.target.providerId, modelId: ctx.target.modelId })}` })
          await explicitSocket.waitFor(message => message.type === 'message_complete', ctx.stepTimeoutMs, 'explicit delegation completion')
          const explicitResponse = await fetch(`${ctx.baseUrl}/api/session-collaboration/${explicitId}/delegation`)
          const explicitSnapshot = await explicitResponse.json() as any
          const explicitBatch = explicitSnapshot.batches.find((item: any) => item.requestId === 'mock-explicit')
          if (explicitBatch?.state !== 'launched' || !explicitBatch.sessions[0]?.sessionId) throw new Error(`An exact human assignment should launch automatically: ${JSON.stringify(explicitSnapshot.batches)}`)
          await fetch(`${ctx.baseUrl}/api/session-collaboration/${explicitId}/stop`, { method: 'POST' })
        } finally { explicitSocket.close() }
      } finally { socket.close() }
    },
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

    async 'mock-provider-refusal-recovers'(ctx) {
      const sessionId = await ctx.createSession()
      const socket = await ctx.openSocket(sessionId)
      const assertRuntime = async () => {
        const response = await fetch(`${ctx.baseUrl}/api/sessions/${sessionId}/summary`)
        if (!response.ok) throw new Error(`reading refusal session runtime failed: ${response.status}`)
        const session = await response.json() as { runtimeProviderId?: string | null; runtimeModelId?: string }
        if (session.runtimeProviderId !== ctx.target.providerId || session.runtimeModelId !== ctx.target.modelId) {
          throw new Error(`Refusal changed the selected provider or model: ${JSON.stringify(session)}`)
        }
      }
      const requestStart = requests.length
      try {
        ctx.pinRuntime(socket)
        const start = socket.messages.length
        socket.send({ type: 'user_message', content: `${UPSTREAM_REFUSAL_TRIGGER}: refuse this turn.` })
        await socket.waitFor(m => m.type === 'message_complete', ctx.stepTimeoutMs, 'refused turn completion', start)
        const errors = socket.messages.slice(start).filter(m => m.type === 'error')
        const detail = errors.map(m => String(m.message ?? '')).join('\n')
        if (!/selected model.*refus/i.test(detail)) throw new Error(`Refusal did not identify the selected model: ${detail}`)
        if (/anthropic\.com|Usage Policy|claude-sonnet|Claude Code/i.test(detail)) {
          throw new Error(`Third-party refusal was attributed to Anthropic: ${detail}`)
        }
        if (requests.slice(requestStart).some(request => request.body.model !== ctx.target.modelId)) {
          throw new Error('Refusal switched the upstream request model')
        }
        await assertRuntime()

        const next = socket.messages.length
        const recoveryRequestStart = requests.length
        socket.send({ type: 'user_message', content: 'Reply with one short sentence after refusal.' })
        await socket.waitFor(m => m.type === 'message_complete', ctx.stepTimeoutMs, 'next turn after refusal', next)
        if (!streamedText(socket.messages.slice(next)).trim() || socket.messages.slice(next).some(m => m.type === 'error')) {
          throw new Error('The session did not answer normally after a provider refusal')
        }
        if (requests.length === recoveryRequestStart || requests.slice(recoveryRequestStart).some(request => request.body.model !== ctx.target.modelId)) {
          throw new Error('The turn after refusal did not use the selected upstream model')
        }
        await assertRuntime()
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
