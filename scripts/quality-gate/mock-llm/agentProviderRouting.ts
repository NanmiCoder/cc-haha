import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildProviderManagedEnv } from '../../../src/server/services/providerRuntimeEnv'
import { CURRENT_PROVIDER_INDEX_SCHEMA_VERSION } from '../../../src/server/services/persistentStorageMigrations'
import { createQualityGateSandbox } from '../sandbox'
import { startMockLlmServer } from './server'
import type { MockReply, MockRequest } from './scriptedModel'

const STEP_TIMEOUT_MS = 60_000
const textReply = (text: string): MockReply => ({
  kind: 'message', content: [{ type: 'text', text }], stopReason: 'end_turn',
})
type WireRequest = { endpoint: string; path: string; model?: string; apiKey: string | null; authorization: string | null }

function metadataUnder(directory: string): Array<{ providerId?: string; providerModel?: string }> {
  const metadata: Array<{ providerId?: string; providerModel?: string }> = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) metadata.push(...metadataUnder(path))
    else if (entry.name.endsWith('.meta.json')) metadata.push(JSON.parse(readFileSync(path, 'utf8')))
  }
  return metadata
}

/** Real Agent execution; only three isolated loopback model endpoints are scripted. */
export async function runAgentProviderRoutingScenario(rootDir: string, artifactDir: string) {
  mkdirSync(artifactDir, { recursive: true })
  const results: Array<{ id: string; status: 'passed' | 'failed'; requests: WireRequest[]; error?: string }> = []
  for (const concurrent of [false, true]) {
    const id = concurrent ? 'concurrent-providers' : 'saved-provider'
    const sandbox = createQualityGateSandbox({
      label: `agent-provider-${id}`, seedProviders: false,
      sourceConfigDir: join(artifactDir, 'unused-provider-state'),
      source: { PATH: process.env.PATH, SHELL: process.env.SHELL, SYSTEMROOT: process.env.SYSTEMROOT },
    })
    const workDir = join(sandbox.home, 'project')
    mkdirSync(workDir, { recursive: true })
    const requests: WireRequest[] = []
    const result: (typeof results)[number] = { id, status: 'failed', requests }
    const upstreams: Array<{ stop(): Promise<void> }> = []
    const receivedResults = new Set<string>()
    const childModels = new Map<string, string[]>()
    const expected = new Map<string, string>([['B', concurrent ? 'provider-b-fast' : 'provider-b-main']])
    if (concurrent) expected.set('C', 'provider-c-main')
    const doneMarker = `PROVIDER_ROUTING_PARENT_DONE_${id}`
    let emittedAgents = false
    let rootResult = false
    let child
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    let releaseChildren!: () => void
    const bothChildren = new Promise<void>(resolve => { releaseChildren = resolve })
    const arrivals = new Set<string>()

    function startEndpoint(endpoint: string, reply: (request: MockRequest) => MockReply) {
      const scripted = startMockLlmServer(reply)
      const gateway = Bun.serve({
        hostname: '127.0.0.1', port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname
          const body = await request.clone().json().catch(() => ({})) as MockRequest
          requests.push({
            endpoint, path, model: body.model,
            apiKey: request.headers.get('x-api-key'), authorization: request.headers.get('authorization'),
          })
          if (concurrent && endpoint !== 'A' && path.endsWith('/v1/messages') && JSON.stringify(body.messages).includes(`PROVIDER_CHILD_PROMPT_${endpoint}`)) {
            arrivals.add(endpoint)
            if (arrivals.size === 2) releaseChildren()
            // A serialized implementation cannot pass by serving B completely
            // before C starts. The scenario timeout also releases this barrier.
            await bothChildren
          }
          return fetch(new Request(new URL(path, scripted.url), request))
        },
      })
      upstreams.push({ async stop() { gateway.stop(true); await scripted.stop() } })
      return `http://127.0.0.1:${gateway.port}`
    }

    try {
      const parentUrl = startEndpoint('A', request => {
        if (!request.tools?.some(tool => tool.name === 'Agent')) return textReply('Mock auxiliary reply')
        if (emittedAgents) {
          for (const message of request.messages ?? []) {
            if (!Array.isArray(message.content)) continue
            for (const block of message.content) {
              if (block.type === 'tool_result' && !block.is_error && block.tool_use_id && JSON.stringify(block.content).includes('PROVIDER_CHILD_DONE_')) {
                receivedResults.add(block.tool_use_id)
              }
            }
          }
          return textReply(doneMarker)
        }
        emittedAgents = true
        return {
          kind: 'message', stopReason: 'tool_use',
          content: [...expected.keys()].map(endpoint => ({
            type: 'tool_use' as const, id: `provider_agent_${endpoint}`, name: 'Agent',
            input: {
              subagent_type: endpoint === 'B' ? 'statusline-setup' : 'Explore',
              description: `Verify isolated provider ${endpoint}`,
              prompt: `PROVIDER_CHILD_PROMPT_${endpoint}: Return the fixture marker.`,
            },
          })),
        }
      })
      const childUrl = (endpoint: string) => startEndpoint(endpoint, request => {
        const messages = JSON.stringify(request.messages ?? [])
        if (messages.includes(`PROVIDER_CHILD_PROMPT_${endpoint}`)) {
          const models = childModels.get(endpoint) ?? []
          models.push(request.model ?? '')
          childModels.set(endpoint, models)
          return textReply(`PROVIDER_CHILD_DONE_${endpoint}`)
        }
        return textReply('Mock child auxiliary reply')
      })
      const providers = ['A', 'B', 'C'].map(endpoint => ({
        id: `fixture-provider-${endpoint}`, name: `Fixture ${endpoint}`, presetId: 'custom',
        baseUrl: endpoint === 'A' ? parentUrl : childUrl(endpoint), apiKey: `fake-key-${endpoint}`,
        authStrategy: 'api_key' as const, apiFormat: 'anthropic' as const, runtimeKind: 'anthropic_compatible' as const,
        models: {
          main: `provider-${endpoint.toLowerCase()}-main`, haiku: `provider-${endpoint.toLowerCase()}-fast`,
          sonnet: `provider-${endpoint.toLowerCase()}-standard`, opus: `provider-${endpoint.toLowerCase()}-large`,
        },
      }))
      mkdirSync(join(sandbox.configDir, 'cc-haha'), { recursive: true })
      const indexPath = join(sandbox.configDir, 'cc-haha', 'providers.json')
      writeFileSync(indexPath, JSON.stringify({
        schemaVersion: CURRENT_PROVIDER_INDEX_SCHEMA_VERSION,
        activeId: providers[0]!.id, providers, providerOrder: providers.map(provider => provider.id), officialProviderModels: {},
      }))
      writeFileSync(join(sandbox.configDir, 'settings.json'), JSON.stringify({
        builtInAgentOverrides: {
          'statusline-setup': { providerId: providers[1]!.id, ...(concurrent ? { model: 'haiku' } : {}) },
          Explore: { providerId: providers[2]!.id },
        },
      }))
      child = Bun.spawn([
        process.execPath, '--no-env-file', '--feature=TRANSCRIPT_CLASSIFIER', '--preload', join(rootDir, 'preload.ts'),
        join(rootDir, 'src/entrypoints/cli.tsx'),
        '--print', '--model', 'provider-a-main', '--permission-mode', 'bypassPermissions',
        '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--debug-file', join(artifactDir, `${id}.debug.log`),
      ], {
        cwd: workDir, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
        env: {
          ...sandbox.env, ...buildProviderManagedEnv(providers[0]!),
          CALLER_DIR: workDir, CC_HAHA_SKIP_DOTENV: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
        },
      })
      const processChild = child
      timer = setTimeout(() => { timedOut = true; releaseChildren(); processChild.kill('SIGKILL') }, STEP_TIMEOUT_MS)
      const readStdout = async () => {
        const decoder = new TextDecoder()
        let stdout = ''
        for await (const chunk of processChild.stdout) {
          stdout += decoder.decode(chunk, { stream: true })
          rootResult ||= stdout.split('\n').some(line => {
            try {
              const message = JSON.parse(line)
              return message.type === 'result' && !message.is_error && message.result === doneMarker
            } catch { return false }
          })
        }
        return stdout + decoder.decode()
      }
      const output = Promise.all([readStdout(), new Response(child.stderr).text()])
      child.stdin.write(`${JSON.stringify({
        type: 'user', message: { role: 'user', content: 'Run the provider routing fixture using the requested built-in agents.' },
        parent_tool_use_id: null, session_id: '',
      })}\n`)
      child.stdin.flush()
      while (!rootResult && child.exitCode === null && !timedOut) await Bun.sleep(50)
      child.stdin.end()
      const [exitCode, [stdout, stderr]] = await Promise.all([child.exited, output])
      writeFileSync(join(artifactDir, `${id}.log`), `${stdout}\n${stderr}`)
      assert.ok(!timedOut, `${id}: CLI exceeded ${STEP_TIMEOUT_MS}ms`)
      assert.equal(exitCode, 0, `${id}: CLI failed: ${stderr}\n${stdout}`)
      assert.ok(rootResult, `${id}: parent result did not finish`)
      const rootRequests = requests.filter(request => request.endpoint === 'A' && request.path.endsWith('/v1/messages'))
      assert.ok(rootRequests.length >= 2, `${id}: child result did not return to parent A`)
      assert.ok(rootRequests.every(request => request.model === 'provider-a-main'), `${id}: parent model was replaced`)
      const metadata = metadataUnder(sandbox.configDir)
      for (const [endpoint, model] of expected) {
        assert.ok(receivedResults.has(`provider_agent_${endpoint}`), `${id}: agent ${endpoint} result failed or was lost`)
        assert.ok(childModels.get(endpoint)?.length, `${id}: no child ${endpoint} request reached its endpoint`)
        assert.ok(childModels.get(endpoint)!.every(value => value === model), `${id}: wrong child ${endpoint} model: ${childModels.get(endpoint)}`)
        assert.ok(metadata.some(entry => entry.providerId === `fixture-provider-${endpoint}` && entry.providerModel === model), `${id}: resume metadata lost provider/model ${endpoint}`)
      }
      for (const request of requests.filter(request => request.path.endsWith('/v1/messages'))) {
        assert.equal(request.apiKey, `fake-key-${request.endpoint}`, `${id}: ${request.endpoint} received another provider's API key`)
        assert.equal(request.authorization, null, `${id}: inherited bearer token leaked into ${request.endpoint}`)
      }
      assert.equal(JSON.parse(readFileSync(indexPath, 'utf8')).activeId, providers[0]!.id, `${id}: an agent activated its provider globally`)
      if (concurrent) assert.equal(arrivals.size, 2, `${id}: child providers did not overlap`)
      result.status = 'passed'
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error)
    } finally {
      clearTimeout(timer)
      releaseChildren()
      if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
      await Promise.all(upstreams.map(upstream => upstream.stop()))
      const mutations = sandbox.detectUserStateMutations()
      sandbox.cleanup()
      assert.deepEqual(mutations, [], 'provider-routing scenario mutated its isolated source state')
      results.push(result)
      writeFileSync(join(artifactDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
    }
  }
  const failed = results.filter(result => result.status === 'failed')
  assert.equal(failed.length, 0, failed.map(result => `${result.id}: ${result.error}`).join('\n'))
  return results
}
