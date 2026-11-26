import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ANTIGRAVITY_CLIENT_INFO,
  ANTIGRAVITY_DEFAULT_MODEL,
  ANTIGRAVITY_PROVIDER_ID,
  acpModeToCcHahaPermissionMode,
  ccHahaPermissionModeToAcpMode,
  discoverAntigravity,
  getAntigravityStatus,
  openAntigravityAcp,
  resetAntigravityStatusForTests,
} from '../services/antigravityAcp.js'
import {
  AntigravityConversation,
  parseSubagentToolCallPrefix,
} from '../services/antigravityConversation.js'
import type { AntigravityComputerUseBridge } from '../services/antigravityComputerUseBridge.js'
import { handleProvidersApi } from '../api/providers.js'
import { startServer } from '../index.js'
import { sessionService } from '../services/sessionService.js'
import { conversationService } from '../services/conversationService.js'
import type { ClientMessage, ServerMessage } from '../ws/events.js'

const BANNED_FLAGS = [
  '--cloud_code_endpoint',
  '--override_user_agent_name',
  '--use_stubby_auth',
]

type WireRecord = {
  pid: number
  argv?: string[]
  hasAnthropicApiKey?: boolean
  jsonrpc?: string
  id?: string | number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message?: string }
}

const FAKE_AGY_SCRIPT = String.raw`
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const dir = import.meta.dir
const modeFile = join(dir, 'agy-mode')
const wireFile = join(dir, 'agy-wire.jsonl')
const mode = readFileSync(modeFile, 'utf8').trim()

const record = (entry) => appendFileSync(wireFile, JSON.stringify({ pid: process.pid, ...entry }) + '\n')
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
const reply = (id, result) => send({ id, result })
const update = (sessionId, sessionUpdate, data) =>
  send({ method: 'session/update', params: { sessionId, update: { ...data, sessionUpdate } } })

record({
  argv: process.argv.slice(2),
  hasAnthropicApiKey: process.env.ANTHROPIC_API_KEY !== undefined,
})

let currentModel = 'gemini-4-neon'
let currentEffort = 'high'
let currentMode = 'default'
let sessionId = mode === 'fresh' ? 'native-session-fresh-2' : 'native-session-1'
let pendingPermission = null

const buildConfigOptions = () => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: currentModel,
    options: [
      { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
      { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    ],
  },
  {
    id: 'thought_level',
    name: 'Thinking Level',
    category: 'thought_level',
    type: 'select',
    currentValue: currentEffort,
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
      { value: 'xhigh', name: 'Extra' },
    ],
  },
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: currentMode,
    options: [
      { value: 'default', name: 'Default' },
      { value: 'accept-edits', name: 'Accept edits' },
      { value: 'auto', name: 'Auto' },
      { value: 'plan', name: 'Plan' },
    ],
  },
]

const tier = {
  id: 'g1-ultra-lite-tier',
  name: 'Google AI Ultra',
  upgradeUri: 'https://antigravity.google/g1-upgrade',
}

const initialCommands = [
  { name: 'swarm', description: 'Run a multi-agent swarm.' },
  { name: 'plan', description: 'Plan carefully before executing.' },
  { name: 'boost', description: 'Invoke Boost orchestrator.' },
]

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue
  const rpc = JSON.parse(line)
  record(rpc)

  if (!rpc.method && pendingPermission && rpc.id === pendingPermission.rpcId) {
    const p = pendingPermission
    pendingPermission = null
    if (p.kind === 'sequence' && p.next) {
      p.next(rpc.result)
    } else {
      const outcome = rpc.result?.outcome?.outcome
      const optionId = rpc.result?.outcome?.optionId ?? ''
      update(sessionId, 'tool_call_update', {
        toolCallId: p.toolCallId,
        name: p.toolName,
        status: outcome === 'selected' && optionId.startsWith('allow') ? 'completed' : 'failed',
        rawOutput: { output: 'perm:' + optionId },
      })
      update(sessionId, 'agent_message_chunk', {
        content: { type: 'text', text: 'Done:' + optionId },
      })
      update(sessionId, 'usage_update', { used: 12345, size: 200000 })
      reply(p.promptId, { stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 45 } })
    }
    continue
  }

  switch (rpc.method) {
    case 'initialize':
      reply(rpc.id, {
        protocolVersion: 1,
        agentInfo: { name: 'Antigravity ACP Server', version: '1.5.17' },
        agentCapabilities: {
          promptCapabilities: { image: true, embeddedContext: true },
          sessionCapabilities: { resume: {}, additionalDirectories: {} },
          mcpCapabilities: { http: true },
          _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
        },
        authMethods: [{ id: 'oauth-personal' }],
      })
      break
    case 'session/new':
      if (mode === 'login') {
        process.stdout.write('Open the following link to authenticate the ACP server: https://accounts.invalid/login\n')
        break
      }
      if (mode === 'rpc-login') {
        send({ id: rpc.id, error: { code: -32000, message: 'Login required' } })
        break
      }
      update(sessionId, 'available_commands_update', { availableCommands: initialCommands })
      reply(rpc.id, { sessionId, configOptions: buildConfigOptions(), tier })
      break
    case 'session/resume':
      sessionId = rpc.params.sessionId
      update(sessionId, 'available_commands_update', { availableCommands: initialCommands })
      reply(rpc.id, { configOptions: buildConfigOptions(), tier })
      break
    case 'session/set_config_option':
      if (rpc.params.configId === 'model') currentModel = rpc.params.value
      if (rpc.params.configId === 'thought_level') currentEffort = rpc.params.value
      if (rpc.params.configId === 'mode') currentMode = rpc.params.value
      reply(rpc.id, { configOptions: buildConfigOptions() })
      break
    case 'session/prompt': {
      const promptText = rpc.params?.prompt?.[0]?.text ?? ''
      if (mode === 'edit-perm' || promptText.includes('[edit-perm]')) {
        const toolCall = {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_edit_1',
          name: 'edit_file',
          args: { Path: '/tmp/demo.txt', Target: 'world', Replacement: 'antigravity' },
          rawInput: { Path: '/tmp/demo.txt', Target: 'world', Replacement: 'antigravity' },
          status: 'pending',
          kind: 'edit',
          title: 'File demo.txt',
          content: [{ type: 'diff', path: '/tmp/demo.txt', oldText: 'world', newText: 'antigravity' }],
        }
        update(sessionId, 'tool_call', toolCall)
        pendingPermission = { rpcId: 'perm-edit-1', promptId: rpc.id, toolCallId: toolCall.toolCallId, toolName: 'edit_file' }
        send({
          id: 'perm-edit-1',
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall,
            options: [
              { optionId: 'allow_once_id', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'allow_always_id', name: 'Allow always', kind: 'allow_always' },
              { optionId: 'reject_once_id', name: 'Deny', kind: 'reject_once' },
              { optionId: 'reject_always_id', name: 'Never allow', kind: 'reject_always' },
            ],
          },
        })
        break
      }
      if (mode === 'write-bash-subagent') {
        // Test write_file, run_command from subagent, and invoke_subagent
        const writeTool = {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_write_1',
          name: 'write_file',
          args: { Path: '/tmp/new.txt', Content: 'hello\n', Overwrite: true },
          rawInput: { Path: '/tmp/new.txt', Content: 'hello\n', Overwrite: true },
          status: 'pending',
          kind: 'edit',
          title: 'File new.txt',
          content: [{ type: 'diff', path: '/tmp/new.txt', newText: 'hello\n' }],
        }
        update(sessionId, 'tool_call', writeTool)
        pendingPermission = {
          rpcId: 'perm-write-1',
          kind: 'sequence',
          next: () => {
            update(sessionId, 'tool_call_update', { ...writeTool, status: 'completed', rawOutput: {} })
            // Emit invoke_subagent
            const invokeTool = {
              sessionUpdate: 'tool_call',
              toolCallId: 'call_sub_invoke',
              name: 'invoke_subagent',
              args: { Prompt: 'Inspect files', Role: 'Code Explorer', TypeName: 'research' },
              rawInput: { Prompt: 'Inspect files', Role: 'Code Explorer', TypeName: 'research' },
              status: 'in_progress',
              kind: 'other',
              title: 'Run invoke_subagent',
            }
            update(sessionId, 'tool_call', invokeTool)
            update(sessionId, 'tool_call_update', { ...invokeTool, status: 'completed' })
            // Emit child permission with <childId>:call_<digits>
            const subBashTool = {
              sessionUpdate: 'tool_call',
              toolCallId: 'child-conv-1234:call_999',
              name: 'run_command',
              args: { CommandLine: 'ls -la', WaitMsBeforeAsync: 5000, toolSummary: 'List files' },
              rawInput: { CommandLine: 'ls -la', WaitMsBeforeAsync: 5000, toolSummary: 'List files' },
              status: 'pending',
              kind: 'execute',
              title: 'ls -la',
            }
            update(sessionId, 'tool_call', subBashTool)
            pendingPermission = {
              rpcId: 'perm-sub-bash',
              promptId: rpc.id,
              toolCallId: subBashTool.toolCallId,
              toolName: 'run_command',
            }
            send({
              id: 'perm-sub-bash',
              method: 'session/request_permission',
              params: {
                sessionId,
                toolCall: subBashTool,
                options: [
                  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
                ],
              },
            })
          },
        }
        send({
          id: 'perm-write-1',
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: writeTool,
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
            ],
          },
        })
        break
      }
      if (mode === 'cu-auto-approve') {
        const cuTool = {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_cu_1',
          name: 'mcp_cc-haha-computer-use_js',
          args: { code: 'return 1', toolSummary: 'Inspect app' },
          rawInput: { code: 'return 1', toolSummary: 'Inspect app' },
          status: 'pending',
          kind: 'other',
          title: 'Run mcp_cc-haha-computer-use_js',
        }
        update(sessionId, 'tool_call', cuTool)
        pendingPermission = {
          rpcId: 'perm-cu-1',
          kind: 'sequence',
          next: (cuRes) => {
            update(sessionId, 'tool_call_update', {
              ...cuTool,
              status: 'completed',
              rawOutput: { output: 'cu:' + (cuRes?.outcome?.optionId ?? '') },
            })
            const otherMcp = {
              sessionUpdate: 'tool_call',
              toolCallId: 'call_other_mcp_1',
              name: 'mcp_thirdparty_tool',
              args: { query: 'x' },
              rawInput: { query: 'x' },
              status: 'pending',
              kind: 'other',
              title: 'Run mcp_thirdparty_tool',
            }
            update(sessionId, 'tool_call', otherMcp)
            pendingPermission = {
              rpcId: 'perm-other-1',
              promptId: rpc.id,
              toolCallId: otherMcp.toolCallId,
              toolName: otherMcp.name,
            }
            send({
              id: 'perm-other-1',
              method: 'session/request_permission',
              params: {
                sessionId,
                toolCall: otherMcp,
                options: [
                  { optionId: 'allow_other', name: 'Allow', kind: 'allow_once' },
                  { optionId: 'deny_other', name: 'Deny', kind: 'reject_once' },
                ],
              },
            })
          },
        }
        send({
          id: 'perm-cu-1',
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: cuTool,
            options: [
              { optionId: 'allow_cu', name: 'Allow', kind: 'allow_once' },
              { optionId: 'deny_cu', name: 'Deny', kind: 'reject_once' },
            ],
          },
        })
        break
      }
      if (mode === 'fixed-options') {
        const qTool = {
          sessionUpdate: 'tool_call',
          toolCallId: 'interaction_q1',
          title: 'Pick target',
          status: 'pending',
          rawInput: { question: 'Pick target' },
        }
        update(sessionId, 'tool_call', qTool)
        pendingPermission = { rpcId: 'perm-q1', promptId: rpc.id, toolCallId: qTool.toolCallId, toolName: 'interaction' }
        send({
          id: 'perm-q1',
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: qTool,
            options: [
              { optionId: 'opt_desktop', name: 'Desktop', kind: 'allow_once' },
              { optionId: 'opt_mobile', name: 'Mobile', kind: 'allow_once' },
            ],
          },
        })
        break
      }
      update(sessionId, 'agent_thought_chunk', { content: { type: 'text', text: 'Thinking...' } })
      update(sessionId, 'agent_message_chunk', { content: { type: 'text', text: 'Reply:' + currentModel + ':' + currentEffort + ':' + currentMode + ':' + sessionId } })
      update(sessionId, 'usage_update', { used: 24000, size: 200000 })
      reply(rpc.id, { stopReason: 'end_turn', usage: { inputTokens: 200, outputTokens: 50, cachedReadTokens: 100 } })
      break
    }
    case 'session/cancel':
      break
  }
}
`

async function installFakeAgy(sandboxDir: string, mode = 'ready'): Promise<{
  binDir: string
  modeFile: string
  wireFile: string
  readWire: () => Promise<WireRecord[]>
}> {
  const binDir = join(sandboxDir, 'bin')
  await mkdir(binDir, { recursive: true })
  const scriptPath = join(binDir, 'fake-agy.ts')
  const wrapperPath = join(binDir, 'agy')
  const modeFile = join(binDir, 'agy-mode')
  const wireFile = join(binDir, 'agy-wire.jsonl')
  await writeFile(scriptPath, FAKE_AGY_SCRIPT, 'utf8')
  await writeFile(modeFile, mode, 'utf8')
  await writeFile(wrapperPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, 'utf8')
  await chmod(wrapperPath, 0o755)
  return {
    binDir,
    modeFile,
    wireFile,
    readWire: async () => {
      try {
        const raw = await readFile(wireFile, 'utf8')
        return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as WireRecord)
      } catch {
        return []
      }
    },
  }
}

describe('Antigravity ACP server core & integration', () => {
  let sandboxDir = ''
  let savedEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    sandboxDir = await realpath(await mkdtemp(join(tmpdir(), 'cchaha-agy-test-')))
    savedEnv = {
      PATH: process.env.PATH,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    }
    process.env.CLAUDE_CONFIG_DIR = join(sandboxDir, '.claude')
    await mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
    resetAntigravityStatusForTests()
  })

  afterEach(async () => {
    await conversationService.stopAllSessionsAndWait(2_000)
    resetAntigravityStatusForTests()
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(sandboxDir, { recursive: true, force: true })
  })

  test('mode mapping helpers and subagent prefix parser cover all valid and invalid cases', () => {
    expect(ccHahaPermissionModeToAcpMode('default')).toBe('default')
    expect(ccHahaPermissionModeToAcpMode('acceptEdits')).toBe('accept-edits')
    expect(ccHahaPermissionModeToAcpMode('auto')).toBe('auto')
    expect(ccHahaPermissionModeToAcpMode('plan')).toBe('plan')
    expect(ccHahaPermissionModeToAcpMode('bypassPermissions')).toBeUndefined()
    expect(ccHahaPermissionModeToAcpMode('dontAsk')).toBeUndefined()

    expect(acpModeToCcHahaPermissionMode('default')).toBe('default')
    expect(acpModeToCcHahaPermissionMode('accept-edits')).toBe('acceptEdits')
    expect(acpModeToCcHahaPermissionMode('auto')).toBe('auto')
    expect(acpModeToCcHahaPermissionMode('plan')).toBe('plan')
    expect(acpModeToCcHahaPermissionMode('unknown')).toBeUndefined()

    expect(parseSubagentToolCallPrefix('cbce3c87-0047-4ac1-83a6-683ca132ffcc:call_123')).toBe('cbce3c87-0047-4ac1-83a6-683ca132ffcc')
    expect(parseSubagentToolCallPrefix('call_123')).toBeUndefined()
    expect(parseSubagentToolCallPrefix('bad:call_1')).toBeUndefined()
  })

  test('discovery, Providers API contract, compliance guardrails, and login_required detection', async () => {
    const fake = await installFakeAgy(sandboxDir, 'ready')
    process.env.PATH = `${fake.binDir}:/usr/bin:/bin`
    process.env.ANTHROPIC_API_KEY = 'sk-should-never-leak'

    // Before discovery, status is unchecked
    const beforeRes = await handleProvidersApi(
      new Request('http://127.0.0.1/api/providers', { method: 'GET' }),
      new URL('http://127.0.0.1/api/providers'),
      ['api', 'providers'],
    )
    expect(beforeRes.status).toBe(200)
    const beforeBody = await beforeRes.json() as { antigravity: ReturnType<typeof getAntigravityStatus> }
    expect(beforeBody.antigravity.id).toBe(ANTIGRAVITY_PROVIDER_ID)
    expect(beforeBody.antigravity.kind).toBe('acp')
    expect(beforeBody.antigravity.status).toBe('unchecked')

    // POST /api/providers/antigravity-acp/discover returns { antigravity }
    const discoverRes = await handleProvidersApi(
      new Request(`http://127.0.0.1/api/providers/${ANTIGRAVITY_PROVIDER_ID}/discover`, { method: 'POST' }),
      new URL(`http://127.0.0.1/api/providers/${ANTIGRAVITY_PROVIDER_ID}/discover`),
      ['api', 'providers', ANTIGRAVITY_PROVIDER_ID, 'discover'],
    )
    expect(discoverRes.status).toBe(200)
    const discoverBody = await discoverRes.json() as { antigravity: ReturnType<typeof getAntigravityStatus> }
    expect(discoverBody.antigravity).toEqual({
      id: ANTIGRAVITY_PROVIDER_ID,
      kind: 'acp',
      status: 'ready',
      version: '1.5.17',
      currentModelId: 'gemini-4-neon',
      currentEffortLevel: 'high',
      tier: { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra' },
      models: [
        {
          id: 'gemini-4-neon',
          name: 'Gemini 4 Neon',
          supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
          defaultReasoningEffort: 'high',
        },
        {
          id: 'gemini-3.8-flash',
          name: 'Gemini 3.8 Flash',
          supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
          defaultReasoningEffort: 'high',
        },
      ],
    })

    // Verify compliance guardrails on the ACP wire
    const wire = await fake.readWire()
    const spawnRecord = wire.find(w => Array.isArray(w.argv))
    expect(spawnRecord?.argv).toEqual(['acp', '--process-per-session'])
    for (const banned of BANNED_FLAGS) {
      expect(spawnRecord?.argv).not.toContain(banned)
    }
    expect(spawnRecord?.hasAnthropicApiKey).toBe(false)
    const initRecord = wire.find(w => w.method === 'initialize')
    expect(initRecord?.params?.clientInfo).toEqual(ANTIGRAVITY_CLIENT_INFO)

    // Login required mode transitions status to login_required and auth-status reports hasAuth: false
    await writeFile(fake.modeFile, 'login', 'utf8')
    const loginStatus = await discoverAntigravity()
    expect(loginStatus.status).toBe('login_required')

    const authRes = await handleProvidersApi(
      new Request(`http://127.0.0.1/api/providers/auth-status?providerId=${ANTIGRAVITY_PROVIDER_ID}`),
      new URL(`http://127.0.0.1/api/providers/auth-status?providerId=${ANTIGRAVITY_PROVIDER_ID}`),
      ['api', 'providers', 'auth-status'],
    )
    expect(await authRes.json()).toMatchObject({
      hasAuth: false,
      localAgentStatus: 'login_required',
    })
  })

  test('openAntigravityAcp passes additionalDirectories, mcpServers, systemPrompt.append, and enforces bypassPermissions launch guard', async () => {
    const fake = await installFakeAgy(sandboxDir, 'ready')
    process.env.PATH = `${fake.binDir}:/usr/bin:/bin`
    const workDir = join(sandboxDir, 'work')
    const extraDir = join(sandboxDir, 'extra')
    await mkdir(workDir, { recursive: true })
    await mkdir(extraDir, { recursive: true })

    const acp = await openAntigravityAcp(workDir, {
      modelId: 'gemini-3.8-flash',
      effortLevel: 'low',
      permissionMode: 'acceptEdits',
      additionalDirectories: [extraDir],
      mcpServers: [{ type: 'http', name: 'cc-haha-computer-use', url: 'http://127.0.0.1:9999/mcp', headers: [{ name: 'Authorization', value: 'Bearer tok' }] }],
      systemPromptAppend: 'USE_CU_PROMPT',
    })
    try {
      expect(acp.modelId).toBe('gemini-3.8-flash')
      expect(acp.effortLevel).toBe('low')
      expect(acp.permissionMode).toBe('acceptEdits')
      expect(acp.initialAvailableCommands.map(c => c.name)).toEqual(['swarm', 'plan', 'boost'])

      // Switching between supported modes works in-process
      await acp.setPermissionMode('auto')
      expect(acp.permissionMode).toBe('auto')
      await acp.setPermissionMode('plan')
      expect(acp.permissionMode).toBe('plan')

      // Switching into bypassPermissions without launch flag MUST reject
      await expect(acp.setPermissionMode('bypassPermissions')).rejects.toThrow('--dangerously-skip-permissions')
    } finally {
      acp.close()
      await acp.proc.exited
    }

    const wire = await fake.readWire()
    const newCall = wire.find(w => w.method === 'session/new')
    expect(newCall?.params?.additionalDirectories).toEqual([extraDir])
    expect(newCall?.params?.mcpServers).toEqual([
      { type: 'http', name: 'cc-haha-computer-use', url: 'http://127.0.0.1:9999/mcp', headers: [{ name: 'Authorization', value: 'Bearer tok' }] },
    ])
    expect(newCall?.params?._meta).toEqual({
      antigravity: { systemPrompt: { append: 'USE_CU_PROMPT' } },
    })

    // Explicit bypassPermissions launch passes --dangerously-skip-permissions
    const bypassAcp = await openAntigravityAcp(workDir, { permissionMode: 'bypassPermissions' })
    try {
      expect(bypassAcp.launchedWithBypassPermissions).toBe(true)
      expect(bypassAcp.permissionMode).toBe('bypassPermissions')
    } finally {
      bypassAcp.close()
      await bypassAcp.proc.exited
    }
    const wireAfter = await fake.readWire()
    const bypassSpawn = wireAfter.filter(w => Array.isArray(w.argv)).at(-1)
    expect(bypassSpawn?.argv).toEqual(['acp', '--process-per-session', '--dangerously-skip-permissions'])
  })

  test('projects Edit/Write/Bash previews, allow_always, invoke_subagent -> Agent with childId, and subagent permission attribution', async () => {
    const fake = await installFakeAgy(sandboxDir, 'write-bash-subagent')
    process.env.PATH = `${fake.binDir}:/usr/bin:/bin`
    const workDir = join(sandboxDir, 'work-sub')
    const appDataDir = join(sandboxDir, 'agy-appdata')
    await mkdir(workDir, { recursive: true })
    // Seed read-only Antigravity disk registry matching Phase 0 verified schema
    const subagentsDir = join(appDataDir, 'brain', 'native-session-1', '.system_generated', 'subagents')
    await mkdir(subagentsDir, { recursive: true })
    await writeFile(join(subagentsDir, 'child-conv-1234.json'), JSON.stringify({
      conversationId: 'child-conv-1234',
      subagentDescriptor: { typeName: 'research', role: 'Code Explorer' },
      state: 'SUBAGENT_STATE_ALIVE',
      spawnStepIndex: 2,
    }), 'utf8')

    const acp = await openAntigravityAcp(workDir)
    const emitted: Record<string, unknown>[] = []
    const appended: Record<string, unknown>[] = []
    const conv = new AntigravityConversation(
      acp,
      msg => emitted.push(msg),
      async entries => { appended.push(...entries) },
      { antigravityAppDataDir: appDataDir },
    )

    try {
      expect(conv.send([{ type: 'text', text: 'do work' }], 'u1')).toBe(true)

      // Wait for Write permission request
      await waitUntil(() => emitted.some(m => m.type === 'control_request'))
      const writePerm = emitted.find(m => m.type === 'control_request') as { request_id: string; request: Record<string, unknown> }
      expect(writePerm.request.tool_name).toBe('Write')
      expect(writePerm.request.antigravity_tool_name).toBe('write_file')
      expect(writePerm.request.supports_allow_always).toBe(false)
      expect(writePerm.request.input).toMatchObject({ file_path: '/tmp/new.txt', content: 'hello\n' })
      expect(conv.respond(writePerm.request_id, true)).toBe(true)

      // Wait for child subagent Bash permission request
      await waitUntil(() => emitted.filter(m => m.type === 'control_request').length >= 2)
      const subBashPerm = emitted.filter(m => m.type === 'control_request')[1] as { request_id: string; request: Record<string, unknown> }
      expect(subBashPerm.request.tool_name).toBe('Bash')
      expect(subBashPerm.request.antigravity_tool_name).toBe('run_command')
      expect(subBashPerm.request.subagent_name).toBe('Code Explorer')
      expect(subBashPerm.request.agent_id).toBe('child-conv-1234')
      expect(subBashPerm.request.input).toMatchObject({ command: 'ls -la', description: 'List files' })
      expect(conv.respond(subBashPerm.request_id, true)).toBe(true)

      await conv.pendingTurnCompletion

      // Verify invoke_subagent projected to Agent tool_use + tool_result with agentId
      const agentUse = appended.find(e =>
        e.type === 'assistant' &&
        Array.isArray((e.message as { content?: unknown[] })?.content) &&
        ((e.message as { content: Array<Record<string, unknown>> }).content[0]?.name === 'Agent'),
      )
      expect(agentUse).toBeDefined()
      const agentBlock = ((agentUse!.message as { content: Array<Record<string, unknown>> }).content[0])!
      expect(agentBlock.input).toMatchObject({
        description: 'Code Explorer',
        prompt: 'Inspect files',
        subagent_type: 'research',
        antigravityToolName: 'invoke_subagent',
      })
      const agentResult = appended.find(e =>
        e.type === 'user' &&
        Array.isArray((e.message as { content?: unknown[] })?.content) &&
        ((e.message as { content: Array<Record<string, unknown>> }).content[0]?.tool_use_id === agentBlock.id),
      )
      expect(agentResult).toBeDefined()
      const resultContent = ((agentResult!.message as { content: Array<Record<string, unknown>> }).content[0]?.content)
      expect(String(resultContent)).toContain('agentId: child-conv-1234')
    } finally {
      acp.close()
      await acp.proc.exited
    }
  })

  test('auto-approves injected Computer Use MCP permissions when enabled while prompting for other MCP tools', async () => {
    const fake = await installFakeAgy(sandboxDir, 'cu-auto-approve')
    process.env.PATH = `${fake.binDir}:/usr/bin:/bin`
    const workDir = join(sandboxDir, 'work-cu')
    await mkdir(workDir, { recursive: true })

    let lockReleased = 0
    const mockBridge = {
      serverName: 'cc-haha-computer-use' as const,
      url: 'http://127.0.0.1:12345/mcp',
      token: 'tok',
      mcpServerConfig: { type: 'http' as const, name: 'cc-haha-computer-use', url: 'http://127.0.0.1:12345/mcp' },
      systemPromptAppend: 'prompt',
      isEnabled: () => true,
      abortCurrentTurn: () => {},
      resetTurnAbort: () => {},
      releaseLock: async () => { lockReleased++ },
      close: async () => {},
    } satisfies AntigravityComputerUseBridge

    const acp = await openAntigravityAcp(workDir)
    const emitted: Record<string, unknown>[] = []
    const conv = new AntigravityConversation(
      acp,
      msg => emitted.push(msg),
      async () => {},
      { computerUseBridge: mockBridge },
    )

    try {
      expect(conv.send([{ type: 'text', text: 'use cu' }], 'u-cu')).toBe(true)

      // Only the unrelated third-party MCP tool should emit a control_request
      await waitUntil(() => emitted.some(m => m.type === 'control_request'))
      const perms = emitted.filter(m => m.type === 'control_request') as Array<{ request_id: string; request: Record<string, unknown> }>
      expect(perms).toHaveLength(1)
      expect(perms[0]!.request.antigravity_tool_name).toBe('mcp_thirdparty_tool')
      expect(conv.respond(perms[0]!.request_id, true)).toBe(true)

      await conv.pendingTurnCompletion
      expect(lockReleased).toBeGreaterThanOrEqual(1)

      // Verify Computer Use tool was auto-approved on the wire with allow_cu
      const wire = await fake.readWire()
      const cuReply = wire.find(w => w.id === 'perm-cu-1')
      expect(cuReply?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_cu' } })
    } finally {
      acp.close()
      await acp.proc.exited
    }
  })

  test('end-to-end WS lifecycle: Edit preview + allow_always, in-process config switch, slash commands, usage inspection, /clear detach, and resume', async () => {
    const fake = await installFakeAgy(sandboxDir, 'ready')
    process.env.PATH = `${fake.binDir}:/usr/bin:/bin`
    const workDir = join(sandboxDir, 'ws-project')
    await mkdir(workDir, { recursive: true })

    const server = startServer(0, '127.0.0.1')
    const baseUrl = `http://127.0.0.1:${server.port}`
    const wsBaseUrl = `ws://127.0.0.1:${server.port}`

    try {
      // Create Antigravity session
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workDir,
          providerId: ANTIGRAVITY_PROVIDER_ID,
          modelId: ANTIGRAVITY_DEFAULT_MODEL,
          effortLevel: 'high',
          permissionMode: 'default',
        }),
      })
      expect(createRes.status).toBe(201)
      const { sessionId } = await createRes.json() as { sessionId: string }

      // Connect WS
      const received: ServerMessage[] = []
      const ws = new WebSocket(`${wsBaseUrl}/ws/${sessionId}`)
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error('WS failed to connect'))
      })
      ws.onmessage = (event) => {
        received.push(JSON.parse(String(event.data)) as ServerMessage)
      }
      const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg))

      // Turn 1: sends prompt, receives slash commands + usage + reply
      send({ type: 'user_message', content: 'Hello Antigravity' })
      await waitUntil(() => received.some(m => m.type === 'message_complete'))

      // Slash commands come authoritatively from ACP available_commands_update (no Claude fallback)
      const slashRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/slash-commands`)
      expect(slashRes.status).toBe(200)
      const slashBody = await slashRes.json() as { commands: Array<{ name: string }> }
      expect(slashBody.commands.map(c => c.name)).toEqual(['swarm', 'plan', 'boost'])

      // Context usage reflects ACP usage_update
      const inspRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/inspection?contextOnly=1&summaryOnly=1`)
      expect(inspRes.status).toBe(200)
      const inspBody = await inspRes.json() as { context?: { totalTokens?: number; maxTokens?: number } }
      expect(inspBody.context?.totalTokens).toBe(24000)
      expect(inspBody.context?.maxTokens).toBe(200000)

      // nativeSessionId persisted in launchInfo
      const launchAfterTurn1 = await sessionService.getSessionLaunchInfo(sessionId)
      expect(launchAfterTurn1?.runtimeProviderId).toBe(ANTIGRAVITY_PROVIDER_ID)
      expect(launchAfterTurn1?.nativeSessionId).toBe('native-session-1')

      // Switch model + effort in-process and permission mode to acceptEdits
      send({ type: 'set_runtime_config', providerId: ANTIGRAVITY_PROVIDER_ID, modelId: 'gemini-3.8-flash', effortLevel: 'low' })
      await waitUntil(() => received.some(m => m.type === 'runtime_config_applied' && m.modelId === 'gemini-3.8-flash'))

      send({ type: 'set_permission_mode', mode: 'acceptEdits' })
      await waitUntil(() => received.some(m => m.type === 'permission_mode_changed' && m.mode === 'acceptEdits'))

      // Unsupported mode dontAsk returns error
      send({ type: 'set_permission_mode', mode: 'dontAsk' })
      await waitUntil(() => received.some(m => m.type === 'error' && m.code === 'ANTIGRAVITY_UNSUPPORTED'))

      // Turn 2: Edit permission with allow_always!
      const countBeforeTurn2 = received.filter(m => m.type === 'message_complete').length
      send({ type: 'user_message', content: 'Please edit [edit-perm]' })
      await waitUntil(() => received.some(m => m.type === 'permission_request'))
      const permMsg = received.find(m => m.type === 'permission_request') as Extract<ServerMessage, { type: 'permission_request' }>
      expect(permMsg.toolName).toBe('Edit')
      expect(permMsg.antigravityToolName).toBe('edit_file')
      expect(permMsg.supportsAllowAlways).toBe(true)
      expect(permMsg.input).toMatchObject({ file_path: '/tmp/demo.txt', old_string: 'world', new_string: 'antigravity' })

      send({ type: 'permission_response', requestId: permMsg.requestId, allowed: true, rule: 'always' })
      await waitUntil(() => received.filter(m => m.type === 'message_complete').length > countBeforeTurn2)

      // Verify allow_always_id was sent on the ACP wire
      const wireBeforeClear = await fake.readWire()
      const editReply = wireBeforeClear.find(w => w.id === 'perm-edit-1')
      expect(editReply?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_always_id' } })

      // /clear detaches old nativeSessionId and next turn creates a fresh session/new
      await writeFile(fake.modeFile, 'fresh', 'utf8')
      const countBeforeClear = received.filter(m => m.type === 'message_complete').length
      send({ type: 'user_message', content: '/clear' })
      await waitUntil(() => received.some(m => m.type === 'system_notification' && m.subtype === 'session_cleared'))
      await waitUntil(() => received.filter(m => m.type === 'message_complete').length > countBeforeClear)

      const launchAfterClear = await sessionService.getSessionLaunchInfo(sessionId)
      expect(launchAfterClear?.nativeSessionId).toBeUndefined()

      const countBeforeFresh = received.filter(m => m.type === 'message_complete').length
      send({ type: 'user_message', content: 'Fresh start after clear' })
      await waitUntil(() => received.filter(m => m.type === 'message_complete').length > countBeforeFresh)

      const launchAfterFresh = await sessionService.getSessionLaunchInfo(sessionId)
      expect(launchAfterFresh?.nativeSessionId).toBe('native-session-fresh-2')

      // Stop process and send another turn -> resumes persisted native-session-fresh-2 via session/resume
      await conversationService.stopSessionAndWait(sessionId, 2_000, { requireExit: true })
      const countBeforeResume = received.filter(m => m.type === 'message_complete').length
      send({ type: 'user_message', content: 'Continue after restart' })
      await waitUntil(() => received.filter(m => m.type === 'message_complete').length > countBeforeResume)

      const wireAfterResume = await fake.readWire()
      const resumeCall = wireAfterResume.find(w => w.method === 'session/resume')
      expect(resumeCall?.params?.sessionId).toBe('native-session-fresh-2')

      ws.close()
    } finally {
      await conversationService.stopAllSessionsAndWait(2_000)
      server.stop(true)
    }
  }, 20_000)

  test('fixed-option AskUserQuestion rejects free text and resolves chosen option on wire', async () => {
    const fake = await installFakeAgy(sandboxDir, 'fixed-options')
    process.env.PATH = `${fake.binDir}:/usr/bin:/bin`
    const workDir = join(sandboxDir, 'work-q')
    await mkdir(workDir, { recursive: true })

    const acp = await openAntigravityAcp(workDir)
    const emitted: Record<string, unknown>[] = []
    const conv = new AntigravityConversation(acp, msg => emitted.push(msg), async () => {})
    try {
      expect(conv.send([{ type: 'text', text: 'ask me' }], 'u-q')).toBe(true)
      await waitUntil(() => emitted.some(m => m.type === 'control_request'))
      const req = emitted.find(m => m.type === 'control_request') as { request_id: string; request: Record<string, unknown> }
      expect(req.request.tool_name).toBe('AskUserQuestion')
      expect((req.request.input as { allowFreeText?: boolean }).allowFreeText).toBe(false)

      // Free-text option not in provided list is rejected
      expect(conv.respond(req.request_id, true, { answers: { 'Pick target': 'Custom Free Text' } })).toBe(false)
      // Provided option succeeds
      expect(conv.respond(req.request_id, true, { answers: { 'Pick target': 'Mobile' } })).toBe(true)
      await conv.pendingTurnCompletion

      const wire = await fake.readWire()
      const qReply = wire.find(w => w.id === 'perm-q1')
      expect(qReply?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'opt_mobile' } })
    } finally {
      acp.close()
      await acp.proc.exited
    }
  })
})

async function waitUntil(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  throw new Error('Timed out waiting for condition')
}
