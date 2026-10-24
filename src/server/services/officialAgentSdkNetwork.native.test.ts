import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { startMockLlmServer } from '../../../scripts/quality-gate/mock-llm/server.js'

test('native SDK hot-applies credentials and proxy routing without restarting or losing temporary conversation context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-haha-sdk-network-'))
  const root = resolve(import.meta.dir, '../../..')
  const first = startMockLlmServer(() => ({ kind: 'message', stopReason: 'end_turn', content: [{ type: 'text', text: 'FIRST_PROXY' }] }))
  const second = startMockLlmServer(() => ({ kind: 'message', stopReason: 'end_turn', content: [{ type: 'text', text: 'SECOND_PROXY' }] }))
  const firstKeys: Array<string | null> = []
  const secondKeys: Array<string | null> = []
  const recordingProxy = (target: string, keys: Array<string | null>) => Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      keys.push(request.headers.get('x-api-key'))
      const url = new URL(request.url)
      return fetch(new Request(new URL(url.pathname + url.search, target), request))
    },
  })
  const firstProxy = recordingProxy(first.url, firstKeys)
  const secondProxy = recordingProxy(second.url, secondKeys)
  const proxyUrl = `http://127.0.0.1:${secondProxy.port}`
  await mkdir(join(directory, '.claude'), { recursive: true })
  await writeFile(join(directory, '.claude', 'settings.local.json'), JSON.stringify({ env: { HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1' } }))
  const env = createSandboxedTestEnvironment(directory, {
    ANTHROPIC_API_KEY: 'fake-network-key', ANTHROPIC_BASE_URL: 'http://sdk-network.invalid',
    ANTHROPIC_MODEL: 'claude-haiku-5-5',
    HTTP_PROXY: `http://127.0.0.1:${firstProxy.port}`, HTTPS_PROXY: `http://127.0.0.1:${firstProxy.port}`, ALL_PROXY: `http://127.0.0.1:${firstProxy.port}`,
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  })
  // Native HTTP requests target a non-resolvable name; only the chosen loopback
  // proxy can answer. A changed URL in an options object alone cannot pass this.
  const fixture = `
    import assert from 'node:assert/strict'
    const { query } = await import(${JSON.stringify(join(root, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'))})
    const { createOfficialAgentSdkBridge, parseOfficialAgentSdkArgs } = await import(${JSON.stringify(join(root, 'src/server/services/officialAgentSdkBridge.ts'))})
    const sessionId = crypto.randomUUID()
    const events = []
    const config = parseOfficialAgentSdkArgs(['--stdio', '--session-id', sessionId, '--model', 'claude-haiku-5-5', '--no-session-persistence'], process.env.HOME, process.env)
    let capturedOptions
    const bridge = createOfficialAgentSdkBridge(config, { query: params => { capturedOptions=params.options; return query(params) }, send: message => events.push(message) })
    async function waitFor(predicate) {
      const deadline = Date.now() + 20000
      while (!predicate()) { if (Date.now() > deadline) throw new Error('fixture timeout: '+JSON.stringify(events)); await Bun.sleep(10) }
    }
    async function turn(text, n) {
      await bridge.receive(JSON.stringify({type:'user', message:{role:'user',content:text}}))
      await waitFor(() => events.filter(e=>e.type==='result').length===n)
      const result=events.filter(e=>e.type==='result').at(-1)
      assert.equal(result.is_error, false)
      assert.equal(result.result, n===1?'FIRST_PROXY':'SECOND_PROXY')
    }
    try {
      await bridge.ready
      await turn('OFFLINE_NETWORK_FIRST',1)
      await bridge.receive(JSON.stringify({type:'control_request',request_id:'credential-change',request:{subtype:'update_provider_credentials',apiKey:'replacement-network-key'}}))
      assert.equal(events.find(e=>e.response?.request_id==='credential-change').response.subtype,'success')
      await bridge.receive(JSON.stringify({type:'control_request',request_id:'network-change',request:{subtype:'update_network_environment',variables:{
        HTTP_PROXY:${JSON.stringify(proxyUrl)}, HTTPS_PROXY:${JSON.stringify(proxyUrl)}, ALL_PROXY:${JSON.stringify(proxyUrl)},
        http_proxy:${JSON.stringify(proxyUrl)}, https_proxy:${JSON.stringify(proxyUrl)}, all_proxy:${JSON.stringify(proxyUrl)}, API_TIMEOUT_MS:'180000'
      }}}))
      assert.equal(events.find(e=>e.response?.request_id==='network-change').response.subtype,'success')
      await turn('OFFLINE_NETWORK_SECOND',2)
      await bridge.receive(JSON.stringify({type:'control_request',request_id:'reject-key-change',request:{subtype:'update_network_environment',variables:{ANTHROPIC_API_KEY:'other'}}}))
      assert.equal(events.find(e=>e.response?.request_id==='reject-key-change').response.subtype,'error')
      const child = query({prompt:'OFFLINE_NETWORK_CHILD', options:{...capturedOptions,sessionId:crypto.randomUUID()}})
      let childDone=false
      try { for await(const event of child) if(event.type==='result') { assert.equal(event.result,'SECOND_PROXY');assert.equal(event.is_error,false);childDone=true } } finally { child.close() }
      assert.equal(childDone,true)
      console.log('NATIVE_NETWORK_PARITY_OK')
    } finally { bridge.close(); await bridge.done }
  `
  const child = Bun.spawn([process.execPath, '--no-env-file', `--config=${join(root, 'src/entrypoints/officialAgentSdk.bunfig.toml')}`, '--eval', fixture], {
    cwd: directory, env, stdout: 'pipe', stderr: 'pipe',
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const timeout = setTimeout(() => child.kill(), 45_000)
  try {
    const code = await child.exited
    const output = await stdout
    const errors = await stderr
    if (code !== 0) throw new Error(`Native network fixture failed (${code}): ${output}\n${errors}`)
    expect(output).toContain('NATIVE_NETWORK_PARITY_OK')
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(2)
    expect(firstKeys).toEqual(['fake-network-key'])
    expect(secondKeys).toEqual(['replacement-network-key', 'replacement-network-key'])
    expect(JSON.stringify(second.requests[0]!.body.messages)).toContain('OFFLINE_NETWORK_FIRST')
    expect(JSON.stringify(second.requests[0]!.body.messages)).toContain('FIRST_PROXY')
    expect(second.requests[0]!.body.model).toBe('claude-haiku-5-5')
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill()
    await child.exited
    await firstProxy.stop(true)
    await secondProxy.stop(true)
    await first.stop()
    await second.stop()
    await rm(directory, { recursive: true, force: true })
  }
}, 50_000)
