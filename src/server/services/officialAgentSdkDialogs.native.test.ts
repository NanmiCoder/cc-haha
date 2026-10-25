import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { startMockLlmServer } from '../../../scripts/quality-gate/mock-llm/server.js'
import { OFFICIAL_SDK_DIALOG_TOOL } from '../../shared/officialAgentSdkDialogs.js'

test('native SDK MCP form and URL elicitations require explicit desktop answers and preserve cancellation', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'cc-haha-sdk-dialogs-'))
  const workDir = join(sandbox, 'project')
  const script = join(sandbox, 'mcp.ts')
  const receipts = join(sandbox, 'receipts.jsonl')
  const sessionId = crypto.randomUUID()
  const events: Record<string, any>[] = []
  const mcpSource = `import {createInterface} from 'node:readline'; import {appendFileSync} from 'node:fs';
const pending=new Map(); const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(pending.has(m.id)){const call=pending.get(m.id); pending.delete(m.id); appendFileSync(${JSON.stringify(receipts)},JSON.stringify(m.result)+'\\n'); send({id:call,result:{content:[{type:'text',text:'ELICITATION_RESULT '+JSON.stringify(m.result)}]}});return;}
if(m.id===undefined)return;
if(m.method==='initialize')send({id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'dialogs',version:'1.0.0'}}});
else if(m.method==='tools/list')send({id:m.id,result:{tools:[{name:'ask',description:'Ask the user for fixture input',inputSchema:{type:'object',properties:{mode:{type:'string'}},required:['mode']}}]}});
else if(m.method==='tools/call'){const id='ask-'+m.id;pending.set(id,m.id);send({id,method:'elicitation/create',params:m.params.arguments.mode==='url'?{mode:'url',message:'Authorize the offline fixture',url:'https://example.test/offline-auth',elicitationId:'offline-auth'}:{mode:'form',message:'Enter offline fixture values',requestedSchema:{type:'object',properties:{project:{type:'string',enum:['fixture']},enabled:{type:'boolean'},count:{type:'integer',minimum:1,maximum:3}},required:['project','enabled','count']}}});}
else send({id:m.id,result:{}});});`
  const model = startMockLlmServer(request => {
    let marker = ''
    let replied = false
    for (const message of request.messages ?? []) for (const block of typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? []) {
      if (block.type === 'text' && block.text?.startsWith('OFFLINE_DIALOG_')) { marker = block.text; replied = false }
      if (block.type === 'tool_result') replied = true
    }
    if (marker && !replied) return { kind: 'message', stopReason: 'tool_use', content: [{ type: 'tool_use', id: `toolu_${marker}`, name: 'mcp__dialogs__ask', input: { mode: marker.includes('URL') ? 'url' : 'form' } }] }
    return { kind: 'message', stopReason: 'end_turn', content: [{ type: 'text', text: 'Offline dialog completed.' }] }
  })
  let socket: ServerWebSocket<{}> | undefined
  let current: 'form' | 'url' | 'decline' | 'cancel' = 'form'
  const server = Bun.serve<{}>({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === `/sdk/${sessionId}` && url.searchParams.get('token') === 'fixture' && server.upgrade(request, { data: {} })) return
      return new Response('unauthorized', { status: 401 })
    }, websocket: { open(ws) { socket = ws }, message(ws, data) {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        const event = JSON.parse(line)
        events.push(event)
        if (event.type !== 'control_request' || event.request?.subtype !== 'can_use_tool') continue
        let input = event.request.input
        if (event.request.tool_name === OFFICIAL_SDK_DIALOG_TOOL) {
          if (current === 'cancel') {
            ws.send(JSON.stringify({ type: 'control_request', request_id: 'fixture-interrupt', request: { subtype: 'interrupt' } }))
            continue
          }
          input = { sdkDialogResult: current === 'decline' ? { action: 'decline' } : current === 'url' ? { action: 'accept', openedUrl: 'https://example.test/offline-auth' } : { action: 'accept', content: { project: 'fixture', enabled: false, count: 2 } } }
        }
        ws.send(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response: { behavior: 'allow', updatedInput: input } } }))
      }
    } },
  })
  let child: ReturnType<typeof Bun.spawn> | undefined
  let stderr = Promise.resolve('')
  try {
    await mkdir(join(workDir, '.claude'), { recursive: true })
    await writeFile(script, mcpSource)
    await writeFile(join(workDir, '.claude', 'settings.local.json'), JSON.stringify({ enableAllProjectMcpServers: true }))
    await writeFile(join(workDir, '.mcp.json'), JSON.stringify({ mcpServers: { dialogs: { command: process.execPath, args: ['--no-env-file', script] } } }))
    const env = createSandboxedTestEnvironment(sandbox, { ANTHROPIC_API_KEY: 'fake-dialog-key', ANTHROPIC_BASE_URL: model.url,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', ENABLE_TOOL_SEARCH: 'false',
      HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
    })
    child = Bun.spawn([process.execPath, '--no-env-file', 'run', resolve(import.meta.dir, '../../entrypoints/officialAgentSdk.ts'), '--sdk-url', `ws://127.0.0.1:${server.port}/sdk/${sessionId}?token=fixture`, '--session-id', sessionId, '--model', 'claude-haiku-5-5'], { cwd: workDir, env, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })
    stderr = new Response(child.stderr).text()
    async function waitFor(predicate: () => boolean) {
      const deadline = Date.now() + 20_000
      while (!predicate()) {
        if (child!.exitCode !== null) throw new Error(`Native dialog runtime exited: ${await stderr}`)
        if (Date.now() >= deadline) throw new Error(`Native dialog timed out: ${JSON.stringify(events)}`)
        await Bun.sleep(25)
      }
    }
    await waitFor(() => Boolean(socket))
    for (const mode of ['form', 'url', 'decline'] as const) {
      current = mode
      const before = events.filter(event => event.type === 'result').length
      socket!.send(JSON.stringify({ type: 'user', message: { role: 'user', content: `OFFLINE_DIALOG_${mode.toUpperCase()}` } }))
      await waitFor(() => events.filter(event => event.type === 'result').length > before)
    }
    const answers = (await readFile(receipts, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(answers).toEqual([{ action: 'accept', content: { project: 'fixture', enabled: false, count: 2 } }, { action: 'accept' }, { action: 'decline' }])
    expect(events.filter(event => event.type === 'control_request' && event.request?.tool_name === OFFICIAL_SDK_DIALOG_TOOL)).toHaveLength(3)
    expect(events.filter(event => event.type === 'result').every(event => event.is_error === false)).toBe(true)
    expect(model.requests.every(request => request.body.model === 'claude-haiku-5-5')).toBe(true)
    current = 'cancel'
    socket!.send(JSON.stringify({ type: 'user', message: { role: 'user', content: 'OFFLINE_DIALOG_CANCEL' } }))
    await waitFor(() => events.some(event => event.type === 'control_response' && event.response?.request_id === 'fixture-interrupt'))
    expect(events.some(event => event.type === 'control_cancel_request')).toBe(true)
    await waitFor(() => events.filter(event => event.type === 'result').length >= 4)
    current = 'form'
    socket!.send(JSON.stringify({ type: 'user', message: { role: 'user', content: 'OFFLINE_DIALOG_RECOVER' } }))
    await waitFor(() => events.filter(event => event.type === 'result').length >= 5)
    expect(events.filter(event => event.type === 'result').at(-1)?.is_error).toBe(false)
    socket!.send(JSON.stringify({ type: 'control_request', request_id: 'fixture-end', request: { subtype: 'end_session' } }))
    const exit = await child.exited
    if (exit !== 0) throw new Error(`Native dialog shutdown failed: ${await stderr}`)
    expect(exit).toBe(0)
  } finally {
    socket?.close()
    if (child?.exitCode === null) child.kill()
    if (child) await child.exited
    await model.stop()
    await server.stop(true)
    await rm(sandbox, { recursive: true, force: true })
  }
}, 90_000)

test('actual native refusal dialog preserves streamed partials until retry, edit or stop is answered', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'cc-haha-sdk-refusal-dialogs-'))
  const root = resolve(import.meta.dir, '../../..')
  const fixture = startMockLlmServer(request => ({ kind: 'message', stopReason: 'end_turn', content: [{ type: 'text',
    text: request.model === 'claude-fable-5' ? 'OFFLINE_REFUSED_PARTIAL' : 'OFFLINE_FALLBACK_OK',
  }] }))
  // Keep the shared mock API unchanged: this fixture adds the native refusal
  // stop reason at the HTTP boundary, exactly as the provider would stream it.
  const api = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>
    const response = await fetch(fixture.url + new URL(request.url).pathname, { method: 'POST', headers: request.headers, body: JSON.stringify(body) })
    const content = await response.text()
    return new Response(body.model === 'claude-fable-5' ? content.replaceAll('"stop_reason":"end_turn"', '"stop_reason":"refusal"') : content,
      { status: response.status, headers: response.headers })
  } })
  try {
    const script = join(sandbox, 'native-refusal.ts')
    await writeFile(script, `import {query} from ${JSON.stringify(join(root, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'))};
import {createOfficialAgentSdkDialogs} from ${JSON.stringify(join(root, 'src/server/services/officialAgentSdkDialogs.ts'))};
const events=[];const asks=[];const resolutions=[];
const dialogs=createOfficialAgentSdkDialogs(async(name,input,options)=>{
  asks.push({name,input,partialAlreadyDelivered:events.some(e=>e.type==='assistant'&&e.message?.content.some(b=>b.text==='OFFLINE_REFUSED_PARTIAL')),resolvedBeforeAnswer:resolutions.length});
  return {behavior:'allow',updatedInput:{sdkDialogResult:{choice:process.env.FIXTURE_CHOICE}}}
},{onRefusalResolved:e=>{resolutions.push(e)}});
const q=query({prompt:'OFFLINE_NATIVE_REFUSAL',options:{cwd:process.env.HOME+'/project',env:process.env,model:'claude-fable-5',tools:[],maxTurns:2,settingSources:[],settings:{switchModelsOnFlag:false},...dialogs}});
let error;try{for await(const e of q)events.push(e)}catch(e){error=String(e.message)}finally{q.close()}
console.log(JSON.stringify({events,asks,resolutions,error}));`)
    for (const choice of ['retry_fallback', 'edit_prompt', 'cancelled']) {
      const home = join(sandbox, choice)
      await mkdir(join(home, 'project'), { recursive: true })
      const env = createSandboxedTestEnvironment(home, { FIXTURE_CHOICE: choice,
        ANTHROPIC_API_KEY: 'fake-refusal-dialog-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`,
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-8', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5',
        // These force a deterministic fixture route only; production settings and
        // the installed app's native refusal policy are not modified.
        CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL: '1', CLAUDE_CODE_DISABLE_REFUSAL_RETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
      })
      const before = fixture.requests.length
      const child = Bun.spawn([process.execPath, '--no-env-file', script], { cwd: home, env, stdout: 'pipe', stderr: 'pipe' })
      const timer = setTimeout(() => child.kill(), 20_000)
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      clearTimeout(timer)
      if (exit !== 0) throw new Error(`Native ${choice} dialog failed: ${stderr}`)
      const result = JSON.parse(stdout) as { asks: any[]; resolutions: any[]; events: any[] }
      expect(result.asks).toHaveLength(1)
      expect(result.asks[0]).toMatchObject({ name: OFFICIAL_SDK_DIALOG_TOOL, partialAlreadyDelivered: true, resolvedBeforeAnswer: 0,
        input: { nativeKind: 'refusal_fallback_prompt', refusal: { originalModel: 'claude-fable-5', fallbackModel: 'claude-opus-4-8' } } })
      expect(result.resolutions).toHaveLength(1)
      expect(result.resolutions[0]).toMatchObject({ choice, retired: false })
      const partial = result.events.find(event => event.type === 'assistant' && event.message?.content.some((block: any) => block.text === 'OFFLINE_REFUSED_PARTIAL'))
      expect(result.resolutions[0].retractedMessageUuids).toContain(partial.uuid)
      const models = fixture.requests.slice(before).map(request => request.body.model)
      expect(models).toEqual(choice === 'retry_fallback' ? ['claude-fable-5', 'claude-opus-4-8'] : ['claude-fable-5'])
      if (choice === 'retry_fallback') {
        const notice = result.events.find(event => event.subtype === 'model_refusal_fallback')
        expect(notice.retracted_message_uuids).toEqual(result.resolutions[0].retractedMessageUuids)
        expect(result.events.find(event => event.type === 'result')?.result).toBe('OFFLINE_FALLBACK_OK')
      }
    }
  } finally {
    await api.stop(true)
    await fixture.stop()
    await rm(sandbox, { recursive: true, force: true })
  }
}, 90_000)
