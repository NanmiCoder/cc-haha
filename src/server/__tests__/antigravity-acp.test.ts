import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ANTIGRAVITY_BYPASS_EXIT_REQUIRES_RESTART,
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
if (mode === 'hang-sigterm') {
  process.on('SIGTERM', () => {})
}

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
  ...(mode === 'no-mode-config' ? [] : [{
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
  }]),
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
          promptCapabilities: { image: mode !== 'no-images', embeddedContext: true },
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
      if (mode === 'error-discover') {
        send({ id: rpc.id, error: { code: -32603, message: 'Backend exploded' } })
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
      if (rpc.params.configId === 'thought_level' && mode === 'effort-fail' && rpc.params.value === 'xhigh') {
        send({ id: rpc.id, error: { code: -32602, message: 'Effort not supported for model' } })
        break
      }
      if (rpc.params.configId === 'model') currentModel = rpc.params.value
      if (rpc.params.configId === 'thought_level') currentEffort = rpc.params.value
      if (rpc.params.configId === 'mode') currentMode = rpc.params.value
      reply(rpc.id, { configOptions: buildConfigOptions() })
      break
    case 'session/prompt': {
      const promptText = rpc.params?.prompt?.[0]?.text ?? ''
      if (/^\/compact(?:\s|$)/i.test(promptText.trim())) {
        if (promptText.includes('[fail]')) {
          reply(rpc.id, { stopReason: 'refusal' })
          break
        }
        // Matches real agy 1.5.18 silent /compact behavior: only usage_update + end_turn, zero text chunks.
        update(sessionId, 'usage_update', { used: 4200, size: 200000 })
        reply(rpc.id, { stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } })
        break
      }
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
      if (mode === 'sparse-perm') {
        const cuTool = {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_sparse_cu',
          name: 'mcp_cc-haha-computer-use_js',
          rawInput: { code: 'return 42' },
          status: 'pending',
          kind: 'other',
          title: 'Run CU',
        }
        update(sessionId, 'tool_call', cuTool)
        pendingPermission = {
          rpcId: 'perm-sparse-cu',
          kind: 'sequence',
          next: () => {
            update(sessionId, 'tool_call_update', { toolCallId: 'call_sparse_cu', status: 'completed', rawOutput: { output: 'ok' } })
            const editTool = {
              sessionUpdate: 'tool_call',
              toolCallId: 'call_sparse_edit',
              name: 'edit_file',
              rawInput: { Path: '/tmp/sparse.txt', Target: 'old', Replacement: 'new' },
              status: 'pending',
              kind: 'edit',
              title: 'Edit sparse.txt',
              content: [{ type: 'diff', path: '/tmp/sparse.txt', oldText: 'old', newText: 'new' }],
            }
            update(sessionId, 'tool_call', editTool)
            pendingPermission = { rpcId: 'perm-sparse-edit', promptId: rpc.id, toolCallId: 'call_sparse_edit', toolName: 'edit_file' }
            // Sparse permission payload omitting name/rawInput/content
            send({
              id: 'perm-sparse-edit',
              method: 'session/request_permission',
              params: {
                sessionId,
                toolCall: { toolCallId: 'call_sparse_edit', status: 'pending' },
                options: [
                  { optionId: 'allow_edit', name: 'Allow', kind: 'allow_once' },
                  { optionId: 'deny_edit', name: 'Deny', kind: 'reject_once' },
                ],
              },
            })
          },
        }
        // Sparse permission payload omitting name/rawInput
        send({
          id: 'perm-sparse-cu',
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: { toolCallId: 'call_sparse_cu', status: 'pending' },
            options: [
              { optionId: 'allow_sparse_cu', name: 'Allow', kind: 'allow_once' },
              { optionId: 'deny_sparse_cu', name: 'Deny', kind: 'reject_once' },
            ],
          },
        })
        break
      }
      if (mode === 'subagent-filter-flush') {
        const invokeFromContent = {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_sub_content',
          name: 'invoke_subagent',
          rawInput: { Prompt: 'Check JSON content', Role: 'Verifier', TypeName: 'verify' },
          status: 'in_progress',
          kind: 'other',
          title: 'Run invoke_subagent',
        }
        update(sessionId, 'tool_call', invokeFromContent)
        // Pause on a permission request BEFORE finishing the turn so test can verify invoke_subagent was already flushed!
        const gateTool = {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_gate_perm',
          name: 'run_command',
          rawInput: { CommandLine: 'echo gate', toolSummary: 'Gate command' },
          status: 'pending',
          kind: 'execute',
          title: 'echo gate',
        }
        update(sessionId, 'tool_call', gateTool)
        pendingPermission = {
          rpcId: 'perm-gate',
          kind: 'sequence',
          next: () => {
            update(sessionId, 'tool_call_update', { toolCallId: 'call_gate_perm', status: 'completed', rawOutput: { output: 'gate' } })
            update(sessionId, 'tool_call_update', {
              toolCallId: 'call_sub_content',
              status: 'completed',
              content: [{ type: 'content', content: { type: 'text', text: '{"conversationId":"child-from-json-1234","status":"ok"}' } }],
            })
            const invokeMismatch = {
              sessionUpdate: 'tool_call',
              toolCallId: 'call_sub_mismatch',
              name: 'invoke_subagent',
              rawInput: { Prompt: 'Should not match wrong role or swarm worker', Role: 'Security Auditor', TypeName: 'research' },
              status: 'in_progress',
              kind: 'other',
              title: 'Run invoke_subagent',
            }
            update(sessionId, 'tool_call', invokeMismatch)
            update(sessionId, 'tool_call_update', { toolCallId: 'call_sub_mismatch', status: 'completed' })
            reply(rpc.id, { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } })
          },
        }
        send({
          id: 'perm-gate',
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: gateTool,
            options: [
              { optionId: 'allow_gate', name: 'Allow', kind: 'allow_once' },
              { optionId: 'deny_gate', name: 'Deny', kind: 'reject_once' },
            ],
          },
        })
        break
      }
      if (promptText.includes('[detached-after]')) {
        update(sessionId, 'agent_message_chunk', { content: { type: 'text', text: 'Initial done' } })
        reply(rpc.id, { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } })
        setTimeout(() => {
          update(sessionId, 'agent_message_chunk', { content: { type: 'text', text: 'Detached follow-up...' } })
          setTimeout(() => {
            update(sessionId, 'usage_update', { used: 30000, size: 200000 })
          }, 250)
        }, 40)
        break
      }
      if (promptText.includes('[slow-turn]')) {
        update(sessionId, 'agent_message_chunk', { content: { type: 'text', text: 'Working...' } })
        setTimeout(() => {
          reply(rpc.id, { stopReason: 'end_turn', usage: { inputTokens: 15, outputTokens: 5 } })
        }, 200)
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
      expect(writePerm.request.display_name).toBe('Antigravity')
      expect(writePerm.request.description).toBe('File new.txt')
      expect(writePerm.request.antigravity_tool_name).toBe('write_file')
      expect(writePerm.request.supports_allow_always).toBe(false)
      expect(writePerm.request.input).toMatchObject({ file_path: '/tmp/new.txt', content: 'hello\n' })
      expect(conv.respond(writePerm.request_id, true)).toBe(true)

      // Wait for child subagent Bash permission request
      await waitUntil(() => emitted.filter(m => m.type === 'control_request').length >= 2)
      const subBashPerm = emitted.filter(m => m.type === 'control_request')[1] as { request_id: string; request: Record<string, unknown> }
      expect(subBashPerm.request.tool_name).toBe('Bash')
      expect(subBashPerm.request.display_name).toBe('Antigravity')
      expect(subBashPerm.request.description).toBe('List files')
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
      expect(permMsg.displayName).toBe('Antigravity')
      expect(permMsg.description).toBe('File demo.txt')
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

  test('auth-status hasAuth is true ONLY on ready (false on unchecked/error/login_required) and discoverAntigravity enforces bounded SIGKILL exit timeout', async () => {
    const fake = await installFakeAgy(sandboxDir, 'error-discover')
    process.env.PATH = `${fake.binDir}:/usr/bin:/bin`

    // Unchecked before discovery -> hasAuth: false
    const uncheckedRes = await handleProvidersApi(
      new Request(`http://127.0.0.1/api/providers/auth-status?providerId=${ANTIGRAVITY_PROVIDER_ID}`),
      new URL(`http://127.0.0.1/api/providers/auth-status?providerId=${ANTIGRAVITY_PROVIDER_ID}`),
      ['api', 'providers', 'auth-status'],
    )
    expect(await uncheckedRes.json()).toMatchObject({ hasAuth: false, antigravityStatus: 'unchecked' })

    // Error after failed discovery -> hasAuth: false
    const errStatus = await discoverAntigravity()
    expect(errStatus.status).toBe('error')
    const errAuthRes = await handleProvidersApi(
      new Request(`http://127.0.0.1/api/providers/auth-status?providerId=${ANTIGRAVITY_PROVIDER_ID}`),
      new URL(`http://127.0.0.1/api/providers/auth-status?providerId=${ANTIGRAVITY_PROVIDER_ID}`),
      ['api', 'providers', 'auth-status'],
    )
    expect(await errAuthRes.json()).toMatchObject({ hasAuth: false, antigravityStatus: 'error' })

    // Hung agy that ignores SIGTERM -> discoverAntigravity force-kills with SIGKILL in bounded time and returns ready
    await writeFile(fake.modeFile, 'hang-sigterm', 'utf8')
    const started = Date.now()
    const readyStatus = await discoverAntigravity({ exitTimeoutMs: 120 })
    const elapsedMs = Date.now() - started
    expect(readyStatus.status).toBe('ready')
    expect(elapsedMs).toBeLessThan(3_000)

    const readyAuthRes = await handleProvidersApi(
      new Request(`http://127.0.0.1/api/providers/auth-status?providerId=${ANTIGRAVITY_PROVIDER_ID}`),
      new URL(`http://127.0.0.1/api/providers/auth-status?providerId=${ANTIGRAVITY_PROVIDER_ID}`),
      ['api', 'providers', 'auth-status'],
    )
    expect(await readyAuthRes.json()).toMatchObject({ hasAuth: true, antigravityStatus: 'ready' })
  })

  test('openAntigravityAcp rejects non-default mode when mode configOption is absent and bypassPermissions exit requires restart without set_config_option', async () => {
    const fake = await installFakeAgy(sandboxDir, 'no-mode-config')
    process.env.PATH = `${fake.binDir}:/usr/bin:/bin`
    const workDir = join(sandboxDir, 'work-no-mode')
    await mkdir(workDir, { recursive: true })

    // Requesting acceptEdits when CLI exposes no mode configOption must throw ANTIGRAVITY_UNSUPPORTED
    await expect(
      openAntigravityAcp(workDir, { permissionMode: 'acceptEdits' }),
    ).rejects.toMatchObject({ code: 'ANTIGRAVITY_UNSUPPORTED' })

    // Default mode still succeeds when mode configOption is absent
    const defaultAcp = await openAntigravityAcp(workDir, { permissionMode: 'default' })
    try {
      expect(defaultAcp.permissionMode).toBe('default')
    } finally {
      defaultAcp.close()
      await defaultAcp.proc.exited
    }

    // Leaving bypassPermissions on a bypassed process throws ANTIGRAVITY_BYPASS_EXIT_REQUIRES_RESTART without sending set_config_option
    await writeFile(fake.modeFile, 'ready', 'utf8')
    const bypassAcp = await openAntigravityAcp(workDir, { permissionMode: 'bypassPermissions' })
    try {
      await expect(bypassAcp.setPermissionMode('default')).rejects.toThrow(ANTIGRAVITY_BYPASS_EXIT_REQUIRES_RESTART)
      await expect(bypassAcp.setPermissionMode('acceptEdits')).rejects.toThrow(ANTIGRAVITY_BYPASS_EXIT_REQUIRES_RESTART)
      await expect(bypassAcp.setPermissionMode('dontAsk')).rejects.toMatchObject({ code: 'ANTIGRAVITY_UNSUPPORTED' })
    } finally {
      bypassAcp.close()
      await bypassAcp.proc.exited
    }
    const wire = await fake.readWire()
    expect(wire.filter(w => w.method === 'session/set_config_option' && w.params?.configId === 'mode')).toHaveLength(0)
  })

  test('requestPermission merges prior tool_call fields for sparse permission payloads (CU auto-approve + Edit diff)', async () => {
    const fake = await installFakeAgy(sandboxDir, 'sparse-perm')
    process.env.PATH = `${fake.binDir}:/usr/bin:/bin`
    const workDir = join(sandboxDir, 'work-sparse')
    await mkdir(workDir, { recursive: true })

    const mockBridge = {
      serverName: 'cc-haha-computer-use' as const,
      url: 'http://127.0.0.1:12345/mcp',
      token: 'tok',
      mcpServerConfig: { type: 'http' as const, name: 'cc-haha-computer-use', url: 'http://127.0.0.1:12345/mcp' },
      systemPromptAppend: 'prompt',
      isEnabled: () => true,
      abortCurrentTurn: () => {},
      resetTurnAbort: () => {},
      releaseLock: async () => {},
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
      expect(conv.send([{ type: 'text', text: 'sparse test' }], 'u-sparse')).toBe(true)
      await waitUntil(() => emitted.some(m => m.type === 'control_request'))
      const perms = emitted.filter(m => m.type === 'control_request') as Array<{ request_id: string; request: Record<string, unknown> }>
      // Sparse CU permission was auto-approved because name was merged from prior tool_call!
      expect(perms).toHaveLength(1)
      expect(perms[0]!.request.tool_name).toBe('Edit')
      expect(perms[0]!.request.display_name).toBe('Antigravity')
      expect(perms[0]!.request.description).toBe('Edit sparse.txt')
      expect(perms[0]!.request.antigravity_tool_name).toBe('edit_file')
      expect(perms[0]!.request.input).toMatchObject({ file_path: '/tmp/sparse.txt', old_string: 'old', new_string: 'new' })
      expect(conv.respond(perms[0]!.request_id, true)).toBe(true)
      await conv.pendingTurnCompletion

      const wire = await fake.readWire()
      expect(wire.find(w => w.id === 'perm-sparse-cu')?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_sparse_cu' } })
    } finally {
      acp.close()
      await acp.proc.exited
    }
  })

  test('flushes invoke_subagent tool_use before turn ends, parses conversationId from tool.content, and excludes Swarm workers & mismatched roles', async () => {
    const fake = await installFakeAgy(sandboxDir, 'subagent-filter-flush')
    process.env.PATH = `${fake.binDir}:/usr/bin:/bin`
    const workDir = join(sandboxDir, 'work-sub-filter')
    const appDataDir = join(sandboxDir, 'agy-appdata-filter')
    await mkdir(workDir, { recursive: true })
    const subagentsDir = join(appDataDir, 'brain', 'native-session-1', '.system_generated', 'subagents')
    await mkdir(subagentsDir, { recursive: true })
    // Seed a Swarm worker and a mismatched role subagent — neither should match (research, Security Auditor)
    await writeFile(join(subagentsDir, 'swarm-worker-1111.json'), JSON.stringify({
      conversationId: 'swarm-worker-1111',
      subagentDescriptor: { typeName: 'worker', role: 'Swarm Worker (reader)' },
      state: 'SUBAGENT_STATE_ALIVE',
      spawnStepIndex: 1,
    }), 'utf8')
    await writeFile(join(subagentsDir, 'wrong-role-2222.json'), JSON.stringify({
      conversationId: 'wrong-role-2222',
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
      expect(conv.send([{ type: 'text', text: 'run subagents' }], 'u-sub-f')).toBe(true)
      await waitUntil(() => emitted.some(m => m.type === 'control_request'))

      // BEFORE answering gate permission (parent turn is still in progress!), invoke_subagent tool_use was ALREADY flushed!
      await waitUntil(() => appended.some(e =>
        e.type === 'assistant' &&
        Array.isArray((e.message as { content?: unknown[] })?.content) &&
        (e.message as { content: Array<Record<string, unknown>> }).content[0]?.id === 'call_sub_content',
      ))
      expect(conv.isResponding).toBe(true)

      const gatePerm = emitted.find(m => m.type === 'control_request') as { request_id: string }
      expect(conv.respond(gatePerm.request_id, true)).toBe(true)
      await conv.pendingTurnCompletion

      // call_sub_content parsed conversationId from tool.content JSON
      const contentResult = appended.find(e =>
        e.type === 'user' &&
        Array.isArray((e.message as { content?: unknown[] })?.content) &&
        (e.message as { content: Array<Record<string, unknown>> }).content[0]?.tool_use_id === 'call_sub_content',
      )
      expect(String((contentResult?.message as { content: Array<Record<string, unknown>> })?.content[0]?.content)).toContain('agentId: child-from-json-1234')

      // call_sub_mismatch must NOT claim swarm-worker-1111 or wrong-role-2222!
      const mismatchResult = appended.find(e =>
        e.type === 'user' &&
        Array.isArray((e.message as { content?: unknown[] })?.content) &&
        (e.message as { content: Array<Record<string, unknown>> }).content[0]?.tool_use_id === 'call_sub_mismatch',
      )
      const mismatchText = String((mismatchResult?.message as { content: Array<Record<string, unknown>> })?.content[0]?.content)
      expect(mismatchText).not.toContain('swarm-worker-1111')
      expect(mismatchText).not.toContain('wrong-role-2222')
    } finally {
      acp.close()
      await acp.proc.exited
    }
  })

  test('WS bypass enter/leave restarts cleanly with nativeSessionId resume, defers during detached turn, rolls back config failures, handles AntigravityError without leaking callbacks, and returns 409 on subagent POST', async () => {
    const fake = await installFakeAgy(sandboxDir, 'effort-fail')
    process.env.PATH = `${fake.binDir}:/usr/bin:/bin`
    const workDir = join(sandboxDir, 'ws-review-fixes')
    await mkdir(workDir, { recursive: true })

    const server = startServer(0, '127.0.0.1')
    const baseUrl = `http://127.0.0.1:${server.port}`
    const wsBaseUrl = `ws://127.0.0.1:${server.port}`

    try {
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

      // Turn 1 starts the ACP process
      send({ type: 'user_message', content: 'Init session' })
      await waitUntil(() => received.some(m => m.type === 'message_complete'))

      // #8 Partial failure: setModel(gemini-3.8-flash) succeeds, then setEffortLevel(xhigh) fails!
      send({ type: 'set_runtime_config', providerId: ANTIGRAVITY_PROVIDER_ID, modelId: 'gemini-3.8-flash', effortLevel: 'xhigh' })
      await waitUntil(() => received.some(m => m.type === 'error' && m.code === 'ANTIGRAVITY_CONNECTION_FAILED'))
      // session.runtimeSelection & initMessage MUST already reflect gemini-3.8-flash (not stale gemini-4-neon!)
      expect(conversationService.getSessionRuntimeSelection(sessionId)?.modelId).toBe('gemini-3.8-flash')
      expect(conversationService.getSessionInitMessage(sessionId)?.model).toBe('gemini-3.8-flash')

      // Retrying gemini-3.8-flash with a valid effort ('low') must NOT be treated as a no-op!
      send({ type: 'set_runtime_config', providerId: ANTIGRAVITY_PROVIDER_ID, modelId: 'gemini-3.8-flash', effortLevel: 'low' })
      await waitUntil(() => received.some(m => m.type === 'runtime_config_applied' && m.modelId === 'gemini-3.8-flash' && m.effortLevel === 'low'))

      // #8 Full failure (unavailable model) rolls back runtimeOverrides so re-selecting gemini-3.8-flash/low isn't poisoned
      const errCountBeforeUnavailable = received.filter(m => m.type === 'error').length
      send({ type: 'set_runtime_config', providerId: ANTIGRAVITY_PROVIDER_ID, modelId: 'no-such-model', effortLevel: 'low' })
      await waitUntil(() => received.filter(m => m.type === 'error').length > errCountBeforeUnavailable)
      const modelErr = received.filter(m => m.type === 'error').at(-1) as Extract<ServerMessage, { type: 'error' }>
      expect(modelErr.code).toBe('ANTIGRAVITY_MODEL_UNAVAILABLE')
      expect(conversationService.getSessionRuntimeSelection(sessionId)?.modelId).toBe('gemini-3.8-flash')

      // #4 Enter bypassPermissions -> restarts WITH --dangerously-skip-permissions & session/resume
      send({ type: 'set_permission_mode', mode: 'bypassPermissions' })
      await waitUntil(() => received.some(m => m.type === 'permission_mode_changed' && m.mode === 'bypassPermissions'))
      let wire = await fake.readWire()
      const enterBypassSpawn = wire.filter(w => Array.isArray(w.argv)).at(-1)
      expect(enterBypassSpawn?.argv).toEqual(['acp', '--process-per-session', '--dangerously-skip-permissions'])
      expect(wire.filter(w => w.method === 'session/resume').at(-1)?.params?.sessionId).toBe('native-session-1')

      // #4 Trigger a detached turn, then request leaving bypassPermissions while detached turn is active -> MUST defer until detached turn finishes!
      const completionsBeforeDetached = received.filter(m => m.type === 'message_complete').length
      send({ type: 'user_message', content: 'start [detached-after]' })
      await waitUntil(() => received.filter(m => m.type === 'message_complete').length > completionsBeforeDetached)
      // Wait for detached turn to begin (getAntigravityTurnCompletion becomes active while activeUserTurns is empty)
      await waitUntil(() => conversationService.getAntigravityTurnCompletion(sessionId) !== undefined)
      const spawnCountBeforeLeave = (await fake.readWire()).filter(w => Array.isArray(w.argv)).length
      send({ type: 'set_permission_mode', mode: 'default' })
      // Should NOT have restarted immediately while detached turn is still running
      await new Promise(resolve => setTimeout(resolve, 60))
      expect((await fake.readWire()).filter(w => Array.isArray(w.argv)).length).toBe(spawnCountBeforeLeave)
      // Once detached turn ends, deferred restart executes cleanly WITHOUT --dangerously-skip-permissions and with session/resume!
      await waitUntil(() => received.some(m => m.type === 'permission_mode_changed' && m.mode === 'default'))
      wire = await fake.readWire()
      const leaveBypassSpawn = wire.filter(w => Array.isArray(w.argv)).at(-1)
      expect(leaveBypassSpawn?.argv).toEqual(['acp', '--process-per-session'])
      expect(wire.filter(w => w.method === 'session/resume').at(-1)?.params?.sessionId).toBe('native-session-1')
      // Must never have sent set_config_option(mode) to the bypassed process!
      const bypassPid = enterBypassSpawn!.pid
      expect(wire.filter(w => w.pid === bypassPid && w.method === 'session/set_config_option' && w.params?.configId === 'mode')).toHaveLength(0)

      // #12c steerAntigravitySwarmMember returns busy while responding, and routes + emits session_state_changed when idle
      const busyTurnDoneBefore = received.filter(m => m.type === 'message_complete').length
      send({ type: 'user_message', content: 'hold [slow-turn]' })
      await waitUntil(() => conversationService.isAntigravityResponding(sessionId))
      const busyRes = await conversationService.steerAntigravitySwarmMember({
        teamName: 'agy-swarm-native-session-1',
        nativeSessionId: 'native-session-1',
        sessionId,
        memberName: 'reader',
        agentId: 'reader@agy-swarm-native-session-1',
        content: 'ping',
        formattedPrompt: '@reader ping',
      })
      expect(busyRes).toEqual({ routed: false, reason: 'busy' })
      await waitUntil(() => received.filter(m => m.type === 'message_complete').length > busyTurnDoneBefore)

      const steerRes = await conversationService.steerAntigravitySwarmMember({
        teamName: 'agy-swarm-native-session-1',
        nativeSessionId: 'native-session-1',
        sessionId,
        memberName: 'reader',
        agentId: 'reader@agy-swarm-native-session-1',
        content: 'check file',
        formattedPrompt: '@reader check file',
      })
      expect(steerRes).toEqual({ routed: true, delivery: 'steering', formattedPrompt: '@reader check file' })
      await waitUntil(() => !conversationService.isAntigravityResponding(sessionId))
      await waitUntil(() => received.some(m => m.type === 'system_notification' && m.subtype === 'session_state_changed' && (m.data as { state?: string })?.state === 'idle'))

      // #9 Unsupported attachment in handleUserMessage -> emits ANTIGRAVITY_UNSUPPORTED with retryable: false and leaks NO output callbacks
      await writeFile(fake.modeFile, 'no-images', 'utf8')
      await conversationService.stopSessionAndWait(sessionId, 2_000, { requireExit: true })
      const okAfterNoImagesBefore = received.filter(m => m.type === 'message_complete').length
      send({ type: 'user_message', content: 'Boot no-images' })
      await waitUntil(() => received.filter(m => m.type === 'message_complete').length > okAfterNoImagesBefore)

      const activeSessInternal = (conversationService as unknown as { sessions: Map<string, { outputCallbacks: unknown[] }> }).sessions.get(sessionId)
      const callbacksBeforeThrow = activeSessInternal!.outputCallbacks.length
      const errCountBeforeAttach = received.filter(m => m.type === 'error').length
      // Send a base64 image attachment to a no-images Antigravity session -> throws AntigravityError('ANTIGRAVITY_UNSUPPORTED')
      const attachPath = join(workDir, 'tiny.png')
      await writeFile(attachPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))
      send({
        type: 'user_message',
        content: 'Look at this image',
        attachments: [{ id: 'att-1', kind: 'image', mediaType: 'image/png', name: 'tiny.png', path: attachPath }],
      } as unknown as ClientMessage)
      await waitUntil(() => received.filter(m => m.type === 'error').length > errCountBeforeAttach)
      const attachErr = received.filter(m => m.type === 'error').at(-1) as Extract<ServerMessage, { type: 'error' }>
      expect(attachErr.code).toBe('ANTIGRAVITY_UNSUPPORTED')
      expect(attachErr.message).toContain('attachments')
      expect(attachErr.retryable).toBe(false)
      // Verify outputCallbacks did NOT leak!
      expect(activeSessInternal!.outputCallbacks.length).toBeLessThanOrEqual(callbacksBeforeThrow)

      // Subsequent normal turn still works cleanly
      const completionsBeforeNormal = received.filter(m => m.type === 'message_complete').length
      send({ type: 'user_message', content: 'Normal text after attachment error' })
      await waitUntil(() => received.filter(m => m.type === 'message_complete').length > completionsBeforeNormal)

      // #12b POST /api/sessions/:id/subagents/by-tool/:toolUseId/messages on Antigravity returns 409 (not 500)
      await sessionService.appendAntigravityMessages(sessionId, 'native-session-1', [
        {
          type: 'assistant',
          uuid: 'sub-post-u1',
          timestamp: '2026-11-26T12:00:00.000Z',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: 'call_readonly_sub',
              name: 'Agent',
              input: { Prompt: 'Check', Role: 'Explorer', TypeName: 'research', antigravityToolName: 'invoke_subagent' },
            }],
          },
        },
        {
          type: 'user',
          uuid: 'sub-post-u2',
          timestamp: '2026-11-26T12:00:02.500Z',
          durationMs: 2500,
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'call_readonly_sub',
              content: 'agentId: child-readonly-9999\ndone',
            }],
          },
        },
      ], () => true)
      const persistedMessages = await sessionService.getSessionMessages(sessionId)
      const persistedSubTool = persistedMessages.find(m => m.id === 'sub-post-u1')
      const persistedSubRes = persistedMessages.find(m => m.id === 'sub-post-u2')
      expect(persistedSubTool?.timestamp).toBe('2026-11-26T12:00:00.000Z')
      expect(persistedSubRes?.timestamp).toBe('2026-11-26T12:00:02.500Z')
      expect(persistedSubRes?.durationMs).toBe(2500)
      const postSubRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/subagents/by-tool/call_readonly_sub/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Follow up' }),
      })
      expect(postSubRes.status).toBe(409)

      ws.close()
    } finally {
      await conversationService.stopAllSessionsAndWait(2_000)
      server.stop(true)
    }
  }, 25_000)

  test('AntigravityConversation projects read_file/list_dir/grep_search to Read/Glob/Grep with timestamp and durationMs', async () => {
    const emitted: Array<Record<string, unknown>> = []
    const appended: Array<Record<string, unknown>> = []
    let onMessage: ((method: string, params: Record<string, unknown>, id?: number | string) => void) | undefined

    const fakeAcp = {
      sessionId: 'native-proj-1',
      modelId: 'gemini-3.8-flash',
      supportsImages: true,
      isOpen: true,
      initialAvailableCommands: [],
      launchedWithBypassPermissions: false,
      permissionMode: 'default' as const,
      drained: Promise.resolve(),
      set onMessage(fn: ((method: string, params: Record<string, unknown>, id?: number | string) => void) | undefined) {
        onMessage = fn
      },
      get onMessage() {
        return onMessage
      },
      async prompt() {
        onMessage?.('session/update', {
          sessionId: 'native-proj-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call_read_1',
            name: 'read_file',
            title: 'File AGENTS.md',
            status: 'in_progress',
            rawInput: { Path: '/repo/AGENTS.md' },
          },
        })
        onMessage?.('session/update', {
          sessionId: 'native-proj-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call_glob_1',
            name: 'list_dir',
            title: 'List /repo',
            status: 'completed',
            rawInput: { DirectoryPath: '/repo' },
            rawOutput: 'AGENTS.md\nREADME.md',
          },
        })
        onMessage?.('session/update', {
          sessionId: 'native-proj-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call_grep_1',
            name: 'grep_search',
            title: 'Grep foo',
            status: 'completed',
            rawInput: { Query: 'foo', SearchPath: '/repo/src' },
            rawOutput: 'src/a.ts:1:foo',
          },
        })
        await new Promise(resolve => setTimeout(resolve, 25))
        onMessage?.('session/update', {
          sessionId: 'native-proj-1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call_read_1',
            status: 'completed',
            rawOutput: '# AGENTS',
          },
        })
        return { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } }
      },
      reply: () => true,
      cancel: () => true,
      end: () => {},
      close: () => {},
    }

    const conv = new AntigravityConversation(
      fakeAcp as unknown as ConstructorParameters<typeof AntigravityConversation>[0],
      (msg) => emitted.push(msg),
      async (entries) => { appended.push(...entries) },
    )

    expect(conv.send([{ type: 'text', text: 'Inspect repo' }], 'u-proj-1')).toBe(true)
    await conv.pendingTurnCompletion

    const toolUses = emitted
      .filter((m) => m.type === 'assistant')
      .flatMap((m) => ((m.message as { content?: Array<Record<string, unknown>> })?.content ?? []))
      .filter((b) => b.type === 'tool_use')

    expect(toolUses.map((b) => b.name)).toEqual(['Read', 'Glob', 'Grep'])
    expect((toolUses[0]?.input as Record<string, unknown>)?.file_path).toBe('/repo/AGENTS.md')
    expect((toolUses[1]?.input as Record<string, unknown>)?.path).toBe('/repo')
    expect((toolUses[2]?.input as Record<string, unknown>)?.pattern).toBe('foo')

    const readResultMsg = emitted.find((m) => {
      if (m.type !== 'user') return false
      const blocks = (m.message as { content?: Array<Record<string, unknown>> })?.content ?? []
      return blocks.some((b) => b.type === 'tool_result' && b.tool_use_id === 'call_read_1')
    })
    expect(typeof readResultMsg?.timestamp).toBe('string')
    expect(typeof readResultMsg?.durationMs).toBe('number')
    expect((readResultMsg?.durationMs as number)).toBeGreaterThanOrEqual(15)
    expect(appended.some((m) => typeof m.timestamp === 'string')).toBe(true)
  })

  test('/compact emits compacting status -> compact_boundary over WS, persists reloadable boundary without raw /compact user entry, and clears status on failure or cancel', async () => {
    const fake = await installFakeAgy(sandboxDir, 'ready')
    process.env.PATH = `${fake.binDir}:/usr/bin:/bin`
    const workDir = join(sandboxDir, 'ws-compact-project')
    await mkdir(workDir, { recursive: true })

    const server = startServer(0, '127.0.0.1')
    const baseUrl = `http://127.0.0.1:${server.port}`
    const wsBaseUrl = `ws://127.0.0.1:${server.port}`

    try {
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

      // Turn 1 populates context usage to 24000
      send({ type: 'user_message', content: 'Build the widget' })
      await waitUntil(() => received.some(m => m.type === 'message_complete'))

      // Turn 2: manual /compact
      const beforeCompactIdx = received.length
      const completionsBeforeCompact = received.filter(m => m.type === 'message_complete').length
      send({ type: 'user_message', content: '/compact' })
      await waitUntil(() => received.filter(m => m.type === 'message_complete').length > completionsBeforeCompact)

      const compactMessages = received.slice(beforeCompactIdx)
      const compactingIdx = compactMessages.findIndex(m => m.type === 'status' && m.state === 'compacting' && m.verb === 'Compacting conversation')
      const boundaryIdx = compactMessages.findIndex(m => m.type === 'system_notification' && m.subtype === 'compact_boundary')
      const completeIdx = compactMessages.findIndex(m => m.type === 'message_complete')

      expect(compactingIdx).toBeGreaterThanOrEqual(0)
      expect(boundaryIdx).toBeGreaterThan(compactingIdx)
      expect(completeIdx).toBeGreaterThan(boundaryIdx)

      const boundaryMsg = compactMessages[boundaryIdx] as Extract<ServerMessage, { type: 'system_notification' }>
      expect(boundaryMsg.message).toBe('Context compacted')
      expect(boundaryMsg.data).toEqual({ trigger: 'manual', pre_tokens: 24000 })

      // Must NOT emit a raw '/compact' user replay bubble
      const compactReplays = compactMessages.filter(m => m.type === 'user_message_replay')
      expect(compactReplays).toHaveLength(0)

      // Context inspection reflects compacted token count
      const inspRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/inspection?contextOnly=1&summaryOnly=1`)
      expect(inspRes.status).toBe(200)
      const inspBody = await inspRes.json() as { context?: { totalTokens?: number } }
      expect(inspBody.context?.totalTokens).toBe(4200)

      // Reload persistence: sessionService.getSessionMessages returns the compact boundary as a system message and omits raw '/compact' user entry
      const reloaded = await sessionService.getSessionMessages(sessionId)
      const boundaryEntry = reloaded.find(m => m.type === 'system' && m.content === 'Conversation compacted')
      expect(boundaryEntry).toBeDefined()
      const rawCompactUser = reloaded.find(m => m.type === 'user' && JSON.stringify(m.content).includes('/compact'))
      expect(rawCompactUser).toBeUndefined()

      // Failed /compact emits status: null (no compact_boundary) so UI cannot get stuck in compacting
      const beforeFailIdx = received.length
      const completionsBeforeFail = received.filter(m => m.type === 'message_complete').length
      send({ type: 'user_message', content: '/compact [fail]' })
      await waitUntil(() => received.filter(m => m.type === 'message_complete').length > completionsBeforeFail)

      const failMessages = received.slice(beforeFailIdx)
      expect(failMessages.some(m => m.type === 'status' && m.state === 'compacting')).toBe(true)
      expect(failMessages.some(m => m.type === 'system_notification' && m.subtype === 'compact_boundary')).toBe(false)
      expect(failMessages.some(m => m.type === 'status' && m.state === 'thinking')).toBe(true)

      ws.close()
    } finally {
      await conversationService.stopAllSessionsAndWait(2_000)
      server.stop(true)
    }

    // Direct unit test for cancelled /compact resetting status: null without persisting compact_boundary
    let resolvePrompt!: (value: Record<string, unknown>) => void
    const emitted: Array<Record<string, unknown>> = []
    const appended: Array<Record<string, unknown>> = []
    const cancelAcp = {
      sessionId: 'native-compact-cancel',
      modelId: 'gemini-3.8-flash',
      supportsImages: true,
      isOpen: true,
      initialAvailableCommands: [],
      launchedWithBypassPermissions: false,
      permissionMode: 'default' as const,
      drained: Promise.resolve(),
      onMessage: undefined as ((method: string, params: Record<string, unknown>, id?: number | string) => void) | undefined,
      prompt: () => new Promise<Record<string, unknown>>(resolve => { resolvePrompt = resolve }),
      reply: () => true,
      cancel: () => {
        setTimeout(() => resolvePrompt({ stopReason: 'cancelled' }), 5)
        return true
      },
      end: () => {},
      close: () => {},
    }
    const conv = new AntigravityConversation(
      cancelAcp as unknown as ConstructorParameters<typeof AntigravityConversation>[0],
      msg => emitted.push(msg),
      async entries => { appended.push(...entries) },
    )
    expect(conv.send([{ type: 'text', text: '/compact' }], 'u-cancel-compact')).toBe(true)
    await waitUntil(() => emitted.some(m => m.type === 'system' && m.subtype === 'status' && m.status === 'compacting'))
    expect(conv.cancel()).toBe(true)
    await conv.pendingTurnCompletion

    expect(emitted.some(m => m.type === 'system' && m.subtype === 'compact_boundary')).toBe(false)
    expect(emitted.some(m => m.type === 'system' && m.subtype === 'status' && m.status === null)).toBe(true)
    expect(appended).toHaveLength(0)
  }, 20_000)

  test('tracks real model-active API/decode/TTFT timing excluding non-daemon tool & permission wait and sums thoughtTokens into outputTokens', async () => {
    const emitted: Array<Record<string, unknown>> = []
    let onMessage: ((method: string, params: Record<string, unknown>, id?: number | string) => void) | undefined
    let resolvePerm!: () => void

    const fakeAcp = {
      sessionId: 'native-timing-1',
      modelId: 'gemini-4-neon',
      supportsImages: true,
      isOpen: true,
      initialAvailableCommands: [],
      launchedWithBypassPermissions: false,
      permissionMode: 'default' as const,
      drained: Promise.resolve(),
      set onMessage(fn: ((method: string, params: Record<string, unknown>, id?: number | string) => void) | undefined) {
        onMessage = fn
      },
      get onMessage() {
        return onMessage
      },
      async prompt() {
        // Prefill / TTFT phase (~35ms)
        await new Promise(resolve => setTimeout(resolve, 35))
        onMessage?.('session/update', {
          sessionId: 'native-timing-1',
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Planning...' } },
        })
        // Decode phase 1 (~30ms)
        await new Promise(resolve => setTimeout(resolve, 30))
        onMessage?.('session/update', {
          sessionId: 'native-timing-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Running command...' } },
        })
        // Non-daemon tool + permission prompt -> MUST pause API timer!
        const bashTool = {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_bash_slow',
          name: 'run_command',
          status: 'pending',
          rawInput: { CommandLine: 'sleep 0.2', toolSummary: 'Slow bash' },
          title: 'sleep 0.2',
        }
        onMessage?.('session/update', { sessionId: 'native-timing-1', update: bashTool })
        const permDone = new Promise<void>(resolve => { resolvePerm = resolve })
        onMessage?.('session/request_permission', {
          sessionId: 'native-timing-1',
          toolCall: bashTool,
          options: [{ optionId: 'allow_1', name: 'Allow', kind: 'allow_once' }],
        }, 'perm-slow-1')
        await permDone
        // Simulate 160ms of Bash tool execution AFTER user approves -> still paused!
        await new Promise(resolve => setTimeout(resolve, 160))
        onMessage?.('session/update', {
          sessionId: 'native-timing-1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call_bash_slow',
            status: 'completed',
            rawOutput: { output: 'done' },
          },
        })
        // Daemon tool starts while model continues generating -> MUST NOT pause API timer
        onMessage?.('session/update', {
          sessionId: 'native-timing-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call_daemon_1',
            name: 'run_command',
            status: 'in_progress',
            rawInput: { CommandLine: 'vite', IsDaemon: true },
            title: 'Dev server',
          },
        })
        // Model phase 2 (~35ms)
        await new Promise(resolve => setTimeout(resolve, 15))
        onMessage?.('session/update', {
          sessionId: 'native-timing-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'All ' } },
        })
        await new Promise(resolve => setTimeout(resolve, 25))
        onMessage?.('session/update', {
          sessionId: 'native-timing-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done.' } },
        })
        return {
          stopReason: 'end_turn',
          usage: { inputTokens: 300, outputTokens: 120, thoughtTokens: 80, cachedReadTokens: 100 },
        }
      },
      reply: () => {
        resolvePerm?.()
        return true
      },
      cancel: () => true,
      end: () => {},
      close: () => {},
    }

    const conv = new AntigravityConversation(
      fakeAcp as unknown as ConstructorParameters<typeof AntigravityConversation>[0],
      msg => emitted.push(msg),
      async () => {},
    )

    expect(conv.send([{ type: 'text', text: 'Run slow bash' }], 'u-timing-1')).toBe(true)
    await waitUntil(() => emitted.some(m => m.type === 'control_request'))
    // Hold permission open for ~100ms before approving -> MUST be excluded from API duration!
    await new Promise(resolve => setTimeout(resolve, 100))
    const permReq = emitted.find(m => m.type === 'control_request') as { request_id: string }
    expect(conv.respond(permReq.request_id, true)).toBe(true)
    await conv.pendingTurnCompletion

    const resultFrame = emitted.find(m => m.type === 'result') as Record<string, unknown>
    expect(resultFrame).toBeDefined()
    expect((resultFrame.usage as Record<string, unknown>).output_tokens).toBe(200)
    expect(typeof resultFrame.duration_api_ms).toBe('number')
    expect(typeof resultFrame.duration_ms).toBe('number')

    const apiMs = resultFrame.duration_api_ms as number
    const totalMs = resultFrame.duration_ms as number
    // Total wall-clock includes ~260ms of permission + Bash wait; API duration excludes it
    expect(totalMs).toBeGreaterThanOrEqual(280)
    expect(apiMs).toBeGreaterThanOrEqual(60)
    expect(totalMs - apiMs).toBeGreaterThanOrEqual(200)

    const snapshot = conv.getSessionUsageSnapshot() as Record<string, unknown>
    expect(snapshot.totalOutputTokens).toBe(200)
    expect(snapshot.totalAPIDuration).toBe(apiMs)
    expect(snapshot.totalDuration).toBe(totalMs)
    expect(snapshot.totalDecodeDuration as number).toBeGreaterThanOrEqual(35)
    expect(snapshot.totalTtftDuration as number).toBeGreaterThanOrEqual(20)
    expect((snapshot.models as Array<Record<string, unknown>>)[0]?.outputTokens).toBe(200)
  })

  test('context breakdown splits System & tools, MCP tools (Computer Use), and Messages using turn-1 baseline and read-only disk fallback for resumed sessions', async () => {
    const makeFakeAcp = (sessionId: string, usedByTurn: number[]) => {
      let onMessage: ((method: string, params: Record<string, unknown>, id?: number | string) => void) | undefined
      let turnIndex = 0
      return {
        sessionId,
        modelId: 'gemini-4-neon',
        supportsImages: true,
        isOpen: true,
        initialAvailableCommands: [],
        launchedWithBypassPermissions: false,
        permissionMode: 'default' as const,
        drained: Promise.resolve(),
        set onMessage(fn: ((method: string, params: Record<string, unknown>, id?: number | string) => void) | undefined) {
          onMessage = fn
        },
        get onMessage() {
          return onMessage
        },
        async prompt() {
          const used = usedByTurn[turnIndex++] ?? usedByTurn.at(-1) ?? 0
          onMessage?.('session/update', { sessionId, update: { sessionUpdate: 'usage_update', used, size: 200_000 } })
          return { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } }
        },
        reply: () => true,
        cancel: () => true,
        end: () => {},
        close: () => {},
      }
    }

    // Case 1: Without Computer Use bridge
    const acpNoCu = makeFakeAcp('native-ctx-nocu', [20_100, 35_000])
    const convNoCu = new AntigravityConversation(
      acpNoCu as unknown as ConstructorParameters<typeof AntigravityConversation>[0],
      () => {},
      async () => {},
      { antigravityAppDataDir: join(sandboxDir, 'empty-appdata') },
    )
    // Before any usage, fallback keeps estimateOnly: false
    const initialSnap = convNoCu.getContextUsageSnapshot() as { estimateOnly: boolean; categories: Array<{ name: string; tokens: number }> }
    expect(initialSnap.estimateOnly).toBe(false)
    expect(initialSnap.categories.map(c => c.name)).toEqual(['Messages', 'Free space'])

    // Turn 1: 350 chars => ceil(350 / 3.5) = 100 estimated user tokens => baseline = 20_000
    expect(convNoCu.send([{ type: 'text', text: 'a'.repeat(350) }], 'u-ctx-1')).toBe(true)
    await convNoCu.pendingTurnCompletion
    const snapT1 = convNoCu.getContextUsageSnapshot() as {
      estimateOnly: boolean
      totalTokens: number
      maxTokens: number
      categories: Array<{ name: string; tokens: number; color: string }>
    }
    expect(snapT1.estimateOnly).toBe(true)
    expect(snapT1.totalTokens).toBe(20_100)
    expect(snapT1.maxTokens).toBe(200_000)
    expect(snapT1.categories).toEqual([
      { name: 'System & tools', tokens: 20_000, color: '#6366f1' },
      { name: 'Messages', tokens: 100, color: '#7c3aed' },
      { name: 'Free space', tokens: 179_900, color: '#a1a1aa' },
    ])

    // Turn 2: used grows to 35_000 -> System & tools stays 20_000, Messages becomes 15_000
    expect(convNoCu.send([{ type: 'text', text: 'more context' }], 'u-ctx-2')).toBe(true)
    await convNoCu.pendingTurnCompletion
    const snapT2 = convNoCu.getContextUsageSnapshot() as { categories: Array<{ name: string; tokens: number; color: string }> }
    expect(snapT2.categories).toEqual([
      { name: 'System & tools', tokens: 20_000, color: '#6366f1' },
      { name: 'Messages', tokens: 15_000, color: '#7c3aed' },
      { name: 'Free space', tokens: 165_000, color: '#a1a1aa' },
    ])

    // Case 2: With Computer Use bridge enabled
    const mockBridge = {
      serverName: 'cc-haha-computer-use' as const,
      url: 'http://127.0.0.1:12345/mcp',
      token: 'tok',
      mcpServerConfig: { type: 'http' as const, name: 'cc-haha-computer-use', url: 'http://127.0.0.1:12345/mcp' },
      systemPromptAppend: 'x'.repeat(3500),
      isEnabled: () => true,
      abortCurrentTurn: () => {},
      resetTurnAbort: () => {},
      releaseLock: async () => {},
      close: async () => {},
    } satisfies AntigravityComputerUseBridge

    const acpWithCu = makeFakeAcp('native-ctx-cu', [30_100])
    const convWithCu = new AntigravityConversation(
      acpWithCu as unknown as ConstructorParameters<typeof AntigravityConversation>[0],
      () => {},
      async () => {},
      { computerUseBridge: mockBridge, antigravityAppDataDir: join(sandboxDir, 'empty-appdata') },
    )
    expect(convWithCu.send([{ type: 'text', text: 'b'.repeat(350) }], 'u-ctx-cu-1')).toBe(true)
    await convWithCu.pendingTurnCompletion

    const snapCu = convWithCu.getContextUsageSnapshot() as {
      estimateOnly: boolean
      totalTokens: number
      maxTokens: number
      categories: Array<{ name: string; tokens: number; color: string }>
    }
    expect(snapCu.estimateOnly).toBe(true)
    const sysCat = snapCu.categories.find(c => c.name === 'System & tools')
    const cuCat = snapCu.categories.find(c => c.name === 'MCP tools (Computer Use)')
    const msgCat = snapCu.categories.find(c => c.name === 'Messages')
    const freeCat = snapCu.categories.find(c => c.name === 'Free space')
    expect(sysCat).toBeDefined()
    expect(cuCat).toBeDefined()
    expect(cuCat!.color).toBe('#0ea5e9')
    expect(cuCat!.tokens).toBeGreaterThan(0)
    expect(sysCat!.tokens + cuCat!.tokens).toBe(30_000)
    expect(msgCat?.tokens).toBe(100)
    expect(freeCat?.tokens).toBe(169_900)

    // Case 3: Resumed session reads turn-1 baseline from read-only Antigravity transcript.jsonl
    const appDataDir = join(sandboxDir, 'resumed-appdata')
    const logsDir = join(appDataDir, 'brain', 'native-resumed-1', '.system_generated', 'logs')
    await mkdir(logsDir, { recursive: true })
    await writeFile(
      join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'q'.repeat(700) }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', input_tokens: 15_000, cache_read_tokens: 5_200, output_tokens: 300 }),
      ].join('\n') + '\n',
      'utf8',
    )
    const acpResumed = makeFakeAcp('native-resumed-1', [45_000])
    const convResumed = new AntigravityConversation(
      acpResumed as unknown as ConstructorParameters<typeof AntigravityConversation>[0],
      () => {},
      async () => {},
      { antigravityAppDataDir: appDataDir },
    )
    expect(convResumed.send([{ type: 'text', text: 'Continue later turn' }], 'u-resumed-1')).toBe(true)
    await convResumed.pendingTurnCompletion

    const snapResumed = convResumed.getContextUsageSnapshot() as {
      estimateOnly: boolean
      categories: Array<{ name: string; tokens: number; color: string }>
    }
    expect(snapResumed.estimateOnly).toBe(true)
    // step 1: 15000 + 5200 - ceil(700 / 3.5) = 20000 baseline; 45000 - 20000 = 25000 Messages
    expect(snapResumed.categories).toEqual([
      { name: 'System & tools', tokens: 20_000, color: '#6366f1' },
      { name: 'Messages', tokens: 25_000, color: '#7c3aed' },
      { name: 'Free space', tokens: 155_000, color: '#a1a1aa' },
    ])
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
