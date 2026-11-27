import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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
  getAntigravityDiscoveredCommands,
  getAntigravityStatus,
  openAntigravityAcp,
  resetAntigravityStatusForTests,
} from '../services/antigravityAcp.js'
import { listAntigravitySkillSlashCommands } from '../api/skills.js'
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
let activeSlowPrompt = null

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
    } else if (p.kind === 'elicitation') {
      const action = rpc.result?.action ?? (rpc.error ? 'error:' + rpc.error.code : 'unknown')
      const content = rpc.result?.content ?? null
      update(sessionId, 'tool_call_update', {
        toolCallId: p.toolCallId,
        name: 'ask_question',
        status: action === 'accept' ? 'completed' : 'failed',
        rawOutput: { action, content },
      })
      update(sessionId, 'agent_message_chunk', {
        content: { type: 'text', text: 'Elicited:' + action + ':' + JSON.stringify(content) },
      })
      update(sessionId, 'usage_update', { used: 14000, size: 200000 })
      reply(p.promptId, { stopReason: 'end_turn', usage: { inputTokens: 130, outputTokens: 50 } })
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
      if (mode !== 'late-commands') {
        update(sessionId, 'available_commands_update', { availableCommands: initialCommands })
      }
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
      if (mode === 'late-commands') {
        update(sessionId, 'available_commands_update', {
          availableCommands: [
            ...initialCommands,
            { name: 'agy-customizations', description: 'AGY built-in customization guide' },
            { name: 'skill-vetter', description: 'Security vetter skill' },
          ],
        })
      }
      if (rpc.params.configId === 'model') currentModel = rpc.params.value
      if (rpc.params.configId === 'thought_level') currentEffort = rpc.params.value
      if (rpc.params.configId === 'mode') currentMode = rpc.params.value
      reply(rpc.id, { configOptions: buildConfigOptions() })
      break
    case 'session/prompt': {
      const promptText = rpc.params?.prompt?.[0]?.text ?? ''
      if (activeSlowPrompt) {
        // Matches real agy acp v1.5.18 steering handoff: immediately resolves the
        // superseded prompt with stopReason: 'end_turn' (no usage), continues
        // streaming, and settles the turn on the steering prompt with final usage.
        const prev = activeSlowPrompt
        clearTimeout(prev.timer)
        activeSlowPrompt = null
        reply(prev.id, { stopReason: 'end_turn' })
        update(sessionId, 'usage_update', { used: 20_791, size: 200_000 })
        if (promptText.includes('[hold-steer]')) {
          update(sessionId, 'agent_message_chunk', { content: { type: 'text', text: 'SteerStep:' + promptText } })
          const timer = setTimeout(() => {
            if (activeSlowPrompt?.id !== rpc.id) return
            activeSlowPrompt = null
            update(sessionId, 'usage_update', { used: 22_000, size: 200_000 })
            reply(rpc.id, { stopReason: 'end_turn', usage: { inputTokens: 250, outputTokens: 60 } })
          }, 250)
          activeSlowPrompt = { id: rpc.id, timer }
        } else {
          setTimeout(() => {
            update(sessionId, 'agent_message_chunk', { content: { type: 'text', text: 'Steered:' + promptText } })
            update(sessionId, 'usage_update', { used: 22_500, size: 200_000 })
            reply(rpc.id, { stopReason: 'end_turn', usage: { inputTokens: 250, outputTokens: 60, cachedReadTokens: 80 } })
          }, 30)
        }
        break
      }
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
        const timer = setTimeout(() => {
          if (activeSlowPrompt?.id !== rpc.id) return
          activeSlowPrompt = null
          reply(rpc.id, { stopReason: 'end_turn', usage: { inputTokens: 15, outputTokens: 5 } })
        }, 250)
        activeSlowPrompt = { id: rpc.id, timer }
        break
      }
      if (mode === 'elicitation-multi' || promptText.includes('[elicitation-multi]')) {
        const askTool = {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_elicit_multi',
          name: 'ask_question',
          title: 'Run ask_question',
          kind: 'other',
          status: 'in_progress',
          rawInput: {
            questions: [
              { question: 'Choose implementation plan', is_multi_select: false, options: ['(Recommended) Plan A', 'Plan B'] },
              { question: 'Enable extra features', is_multi_select: true, options: ['Strict TypeScript', 'Lint, format, and checks', 'Unit tests'] },
              { question: 'How to verify?', is_multi_select: false, options: ['Run locally', 'Skip tests'] },
              { question: 'Any extra notes?', is_multi_select: false, options: [] },
            ],
          },
        }
        update(sessionId, 'tool_call', askTool)
        update(sessionId, 'tool_call_update', { toolCallId: askTool.toolCallId, status: 'pending' })
        pendingPermission = { rpcId: 'elicit-multi-1', promptId: rpc.id, toolCallId: askTool.toolCallId, kind: 'elicitation' }
        send({
          id: 'elicit-multi-1',
          method: 'elicitation/create',
          params: {
            sessionId,
            toolCallId: askTool.toolCallId,
            mode: 'form',
            message: 'The agent has 4 questions.',
            requestedSchema: {
              type: 'object',
              properties: {
                q1: {
                  type: 'string',
                  title: 'Choose implementation plan',
                  oneOf: [
                    { const: 'opt_plan_a', title: '(Recommended) Plan A' },
                    { const: 'opt_plan_b', title: 'Plan B' },
                  ],
                },
                q1_other: {
                  type: 'string',
                  title: 'Other',
                  description: 'Optional free-form answer to: Choose implementation plan',
                },
                q2: {
                  type: 'array',
                  title: 'Enable extra features',
                  items: {
                    anyOf: [
                      { const: 'opt_ts', title: 'Strict TypeScript' },
                      { const: 'opt_lint', title: 'Lint, format, and checks' },
                      { const: 'opt_tests', title: 'Unit tests' },
                    ],
                  },
                },
                q2_other: {
                  type: 'string',
                  title: 'Other',
                  description: 'Optional free-form answer to: Enable extra features',
                },
                q3: {
                  type: 'string',
                  title: 'How to verify?',
                  oneOf: [
                    { const: 'opt_local', title: 'Run locally' },
                    { const: 'opt_skip', title: 'Skip tests' },
                  ],
                },
                q3_other: {
                  type: 'string',
                  title: 'Other',
                  description: 'Optional free-form answer to: How to verify?',
                },
                q4_other: {
                  type: 'string',
                  title: 'Any extra notes?',
                },
              },
            },
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
      if (activeSlowPrompt) {
        const prev = activeSlowPrompt
        clearTimeout(prev.timer)
        activeSlowPrompt = null
        reply(prev.id, { stopReason: 'cancelled' })
      }
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
    expect(initRecord?.params?.clientCapabilities).toEqual({ elicitation: { form: {} } })

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

  test('ACP elicitation/create projects multi-question single/multi-select + write-in to native AskUserQuestion over WS and supports Chat about this, decline, cancel, subagent attribution, and invalid-schema fallback', async () => {
    const fake = await installFakeAgy(sandboxDir, 'elicitation-multi')
    process.env.PATH = `${fake.binDir}:/usr/bin:/bin`
    const workDir = join(sandboxDir, 'work-elicit')
    await mkdir(workDir, { recursive: true })

    const server = startServer(0, '127.0.0.1')
    const baseUrl = `http://127.0.0.1:${server.port}`
    const wsBaseUrl = `ws://127.0.0.1:${server.port}`

    let ws: WebSocket | undefined
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
      ws = new WebSocket(`${wsBaseUrl}/ws/${sessionId}`)
      await new Promise<void>((resolve, reject) => {
        ws!.onopen = () => resolve()
        ws!.onerror = () => reject(new Error('WS failed to connect'))
      })
      ws.onmessage = (event) => {
        received.push(JSON.parse(String(event.data)) as ServerMessage)
      }
      const send = (msg: ClientMessage) => ws!.send(JSON.stringify(msg))

      // Turn 1: multi-question mixed single-select, multi-select (with comma in label), custom write-in, and free-text-only
      send({ type: 'user_message', content: 'Ask multiple questions [elicitation-multi]' })
      await waitUntil(() => received.some(m => m.type === 'permission_request'))

      const permReq = received.find(m => m.type === 'permission_request') as Extract<ServerMessage, { type: 'permission_request' }>
      expect(permReq.toolName).toBe('AskUserQuestion')
      expect(permReq.toolUseId).toBe('call_elicit_multi')
      expect(permReq.input).toEqual({
        allowFreeText: true,
        allowImages: false,
        questions: [
          {
            question: 'Choose implementation plan',
            header: 'Q1',
            multiSelect: false,
            options: [{ label: '(Recommended) Plan A' }, { label: 'Plan B' }],
          },
          {
            question: 'Enable extra features',
            header: 'Q2',
            multiSelect: true,
            options: [{ label: 'Strict TypeScript' }, { label: 'Lint, format, and checks' }, { label: 'Unit tests' }],
          },
          {
            question: 'How to verify?',
            header: 'Q3',
            multiSelect: false,
            options: [{ label: 'Run locally' }, { label: 'Skip tests' }],
          },
          {
            question: 'Any extra notes?',
            header: 'Q4',
            multiSelect: false,
          },
        ],
      })

      // Held ask_question must NOT have emitted a duplicate raw "Antigravity: Run ask_question" tool_use
      const toolUses = received.filter(m => m.type === 'tool_use_complete') as Array<Extract<ServerMessage, { type: 'tool_use_complete' }>>
      expect(toolUses.map(t => t.toolName)).toEqual(['AskUserQuestion'])

      // Submitting empty answers is rejected cleanly with PERMISSION_RESPONSE_INVALID
      const errCountBeforeEmpty = received.filter(m => m.type === 'error').length
      send({ type: 'permission_response', requestId: permReq.requestId, allowed: true, updatedInput: { answers: {} } })
      await waitUntil(() => received.filter(m => m.type === 'error').length > errCountBeforeEmpty)
      expect((received.filter(m => m.type === 'error').at(-1) as Extract<ServerMessage, { type: 'error' }>).code).toBe('PERMISSION_RESPONSE_INVALID')

      // Submit mixed answers: Q1 option + additional note, Q2 multi-select (with comma in option label), Q3 pure free text, Q4 free-text-only
      send({
        type: 'permission_response',
        requestId: permReq.requestId,
        allowed: true,
        updatedInput: {
          answers: {
            'Choose implementation plan': '(Recommended) Plan A',
            'Enable extra features': 'Strict TypeScript, Lint, format, and checks',
            'How to verify?': 'Run CI smoke only',
            'Any extra notes?': 'Keep diff small',
          },
          annotations: {
            'Choose implementation plan': { notes: 'Prefer zero new deps' },
          },
        },
      })
      await waitUntil(() => received.some(m => m.type === 'message_complete'))

      const wire = await fake.readWire()
      const elicitReply = wire.find(w => w.id === 'elicit-multi-1')
      expect(elicitReply?.result).toEqual({
        action: 'accept',
        content: {
          q1: 'opt_plan_a',
          q1_other: 'Prefer zero new deps',
          q2: ['opt_ts', 'opt_lint'],
          q3_other: 'Run CI smoke only',
          q4_other: 'Keep diff small',
        },
      })

      // Reloaded session transcript preserves structured AskUserQuestion answers + annotations
      const detailRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
      expect(detailRes.status).toBe(200)
      const detail = await detailRes.json() as { messages?: Array<{ type: string; content: unknown }> }
      const toolResultEntry = (detail.messages ?? []).find(m =>
        (m.type === 'user' || m.type === 'tool_result') &&
        Array.isArray(m.content) &&
        m.content.some((b: Record<string, unknown>) => b.type === 'tool_result' && b.tool_use_id === 'call_elicit_multi'),
      )
      const resultBlock = ((toolResultEntry?.content as Array<Record<string, unknown>> | undefined) ?? [])
        .find(b => b.type === 'tool_result' && b.tool_use_id === 'call_elicit_multi')
      expect(resultBlock?.content).toMatchObject({
        answers: {
          'Choose implementation plan': '(Recommended) Plan A',
          'Enable extra features': 'Strict TypeScript, Lint, format, and checks',
          'How to verify?': 'Run CI smoke only',
          'Any extra notes?': 'Keep diff small',
        },
        annotations: {
          'Choose implementation plan': { notes: 'Prefer zero new deps' },
        },
      })

      // Turn 2: "Chat about this" (allowed: false + denyMessage) forwards clarify prompt via q1_other and persists handedOff result
      const permsBeforeChat = received.filter(m => m.type === 'permission_request').length
      const completesBeforeChat = received.filter(m => m.type === 'message_complete').length
      send({ type: 'user_message', content: 'Ask again [elicitation-multi]' })
      await waitUntil(() => received.filter(m => m.type === 'permission_request').length > permsBeforeChat)
      const permReq2 = received.filter(m => m.type === 'permission_request').at(-1) as Extract<ServerMessage, { type: 'permission_request' }>
      send({
        type: 'permission_response',
        requestId: permReq2.requestId,
        allowed: false,
        denyMessage: '- "Choose implementation plan"\n  Answer: (Recommended) Plan A',
      })
      await waitUntil(() => received.filter(m => m.type === 'message_complete').length > completesBeforeChat)

      const wireAfterChat = await fake.readWire()
      const chatReply = wireAfterChat.filter(w => w.id === 'elicit-multi-1').at(-1)
      const chatResult = chatReply?.result as { action?: string; content?: { q1_other?: string } } | undefined
      expect(chatResult?.action).toBe('accept')
      expect(typeof chatResult?.content?.q1_other).toBe('string')
      expect(chatResult?.content?.q1_other).toContain('The user wants to clarify these questions.')
      expect(chatResult?.content?.q1_other).toContain('Answer: (Recommended) Plan A')
      const handedOffResult = received
        .filter(m => m.type === 'tool_result' && m.toolUseId === 'call_elicit_multi')
        .at(-1) as Extract<ServerMessage, { type: 'tool_result' }>
      expect(handedOffResult?.content).toMatchObject({ handedOff: true })

      ws.close()
    } finally {
      ws?.close()
      await conversationService.stopAllSessionsAndWait(2_000)
      server.stop(true)
    }

    // Direct unit checks: generic decline (no denyMessage), turn cancel -> { action: 'cancel' }, unsupported mode -> -32602, subagent attribution
    const replies: Array<{ id: number | string; result?: Record<string, unknown>; errorCode?: number }> = []
    const emitted: Array<Record<string, unknown>> = []
    let onMessage: ((method: string, params: Record<string, unknown>, id?: number | string) => void) | undefined
    let resolvePrompt!: (value: Record<string, unknown>) => void

    const appDataDir = join(sandboxDir, 'elicit-sub-appdata')
    const subagentsDir = join(appDataDir, 'brain', 'native-elicit-unit', '.system_generated', 'subagents')
    await mkdir(subagentsDir, { recursive: true })
    await writeFile(join(subagentsDir, 'child-elicit-1234.json'), JSON.stringify({
      conversationId: 'child-elicit-1234',
      subagentDescriptor: { typeName: 'research', role: 'Planner Helper' },
      state: 'SUBAGENT_STATE_ALIVE',
      spawnStepIndex: 1,
    }), 'utf8')

    const unitAcp = {
      sessionId: 'native-elicit-unit',
      modelId: 'gemini-4-neon',
      supportsImages: true,
      isOpen: true,
      initialAvailableCommands: [],
      launchedWithBypassPermissions: false,
      permissionMode: 'default' as const,
      drained: Promise.resolve(),
      set onMessage(fn: typeof onMessage) { onMessage = fn },
      get onMessage() { return onMessage },
      prompt: () => new Promise<Record<string, unknown>>(resolve => { resolvePrompt = resolve }),
      reply: (id: number | string, result?: Record<string, unknown>, errorCode?: number) => {
        replies.push({ id, result, errorCode })
        return true
      },
      cancel: () => {
        setTimeout(() => resolvePrompt({ stopReason: 'cancelled' }), 5)
        return true
      },
      end: () => {},
      close: () => {},
    }

    const conv = new AntigravityConversation(
      unitAcp as unknown as ConstructorParameters<typeof AntigravityConversation>[0],
      msg => emitted.push(msg),
      async () => {},
      { antigravityAppDataDir: appDataDir },
    )

    expect(conv.send([{ type: 'text', text: 'start' }], 'u-elicit-unit')).toBe(true)
    await waitUntil(() => typeof resolvePrompt === 'function')

    // 1. Non-form elicitation (e.g. mode: 'url') returns JSON-RPC -32602 so AGY can fall back safely
    onMessage?.('elicitation/create', {
      sessionId: 'native-elicit-unit',
      mode: 'url',
      message: 'Open URL',
      url: 'https://example.invalid',
    }, 'elicit-url')
    expect(replies.at(-1)).toEqual({ id: 'elicit-url', result: undefined, errorCode: -32602 })

    // 2. Unrecognized non-question form schema also returns -32602
    onMessage?.('elicitation/create', {
      sessionId: 'native-elicit-unit',
      mode: 'form',
      message: 'Enter API token',
      requestedSchema: {
        type: 'object',
        properties: { apiToken: { type: 'string', title: 'API Token' } },
      },
    }, 'elicit-unknown-field')
    expect(replies.at(-1)).toEqual({ id: 'elicit-unknown-field', result: undefined, errorCode: -32602 })

    // 3. Subagent elicitation carries subagent_name + agent_id, and generic decline (no denyMessage) replies { action: 'decline' }
    onMessage?.('elicitation/create', {
      sessionId: 'native-elicit-unit',
      toolCallId: 'child-elicit-1234:call_7',
      mode: 'form',
      message: 'The agent has a question.',
      requestedSchema: {
        type: 'object',
        properties: {
          q1: { type: 'string', title: 'Target branch?', oneOf: [{ const: 'main', title: 'main' }] },
          q1_other: { type: 'string', title: 'Other' },
        },
      },
    }, 'elicit-sub-decline')
    const subReq = emitted.filter(m => m.type === 'control_request').at(-1) as { request_id: string; request: Record<string, unknown> }
    expect(subReq.request.tool_name).toBe('AskUserQuestion')
    expect(subReq.request.subagent_name).toBe('Planner Helper')
    expect(subReq.request.agent_id).toBe('child-elicit-1234')
    expect(conv.respond(subReq.request_id, false)).toBe(true)
    expect(replies.at(-1)).toEqual({ id: 'elicit-sub-decline', result: { action: 'decline' }, errorCode: undefined })

    // 4. Turn cancel replies { action: 'cancel' } to pending elicitation
    onMessage?.('elicitation/create', {
      sessionId: 'native-elicit-unit',
      toolCallId: 'call_cancel_elicit',
      mode: 'form',
      message: 'The agent has a question.',
      requestedSchema: {
        type: 'object',
        properties: {
          q1: { type: 'string', title: 'Proceed?', oneOf: [{ const: 'yes', title: 'Yes' }] },
          q1_other: { type: 'string', title: 'Other' },
        },
      },
    }, 'elicit-cancel-1')
    expect(conv.cancel()).toBe(true)
    await conv.pendingTurnCompletion
    expect(replies.find(r => r.id === 'elicit-cancel-1')).toEqual({
      id: 'elicit-cancel-1',
      result: { action: 'cancel' },
      errorCode: undefined,
    })
  }, 20_000)

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

      // #12c steerAntigravitySwarmMember steers mid-turn while responding, returns busy while a permission prompt is pending, and routes + emits session_state_changed when idle
      const busyTurnDoneBefore = received.filter(m => m.type === 'message_complete').length
      send({ type: 'user_message', content: 'hold [slow-turn]' })
      await waitUntil(() => conversationService.isAntigravityResponding(sessionId))
      const midTurnSteerRes = await conversationService.steerAntigravitySwarmMember({
        teamName: 'agy-swarm-native-session-1',
        nativeSessionId: 'native-session-1',
        sessionId,
        memberName: 'reader',
        agentId: 'reader@agy-swarm-native-session-1',
        content: 'ping',
        formattedPrompt: '@reader ping',
      })
      expect(midTurnSteerRes).toEqual({ routed: true, delivery: 'steering', formattedPrompt: '@reader ping' })
      await waitUntil(() => received.filter(m => m.type === 'message_complete').length > busyTurnDoneBefore)
      expect(received.some(m => m.type === 'content_delta' && typeof m.text === 'string' && m.text.includes('Steered:@reader ping'))).toBe(true)

      const permBusyBefore = received.filter(m => m.type === 'permission_request').length
      const permDoneBefore = received.filter(m => m.type === 'message_complete').length
      send({ type: 'user_message', content: 'Edit file [edit-perm]' })
      await waitUntil(() => received.filter(m => m.type === 'permission_request').length > permBusyBefore)
      const busyPermRes = await conversationService.steerAntigravitySwarmMember({
        teamName: 'agy-swarm-native-session-1',
        nativeSessionId: 'native-session-1',
        sessionId,
        memberName: 'reader',
        agentId: 'reader@agy-swarm-native-session-1',
        content: 'blocked while perm open',
        formattedPrompt: '@reader blocked while perm open',
      })
      expect(busyPermRes).toEqual({ routed: false, reason: 'busy' })
      const permBusyReq = received.filter(m => m.type === 'permission_request').at(-1) as Extract<ServerMessage, { type: 'permission_request' }>
      send({ type: 'permission_response', requestId: permBusyReq.requestId, allowed: true })
      await waitUntil(() => received.filter(m => m.type === 'message_complete').length > permDoneBefore)

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

  test('supports mid-turn steering over WS, preserves transcript order, rejects blocked states without ending the turn, and accounts superseded-prompt usage', async () => {
    const fake = await installFakeAgy(sandboxDir, 'ready')
    process.env.PATH = `${fake.binDir}:/usr/bin:/bin`
    const workDir = join(sandboxDir, 'ws-steer-project')
    await mkdir(workDir, { recursive: true })

    const server = startServer(0, '127.0.0.1')
    const baseUrl = `http://127.0.0.1:${server.port}`
    const wsBaseUrl = `ws://127.0.0.1:${server.port}`

    const received: ServerMessage[] = []
    let ws: WebSocket | undefined
    try {
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workDir,
          providerId: ANTIGRAVITY_PROVIDER_ID,
          modelId: 'gemini-4-neon',
          effortLevel: 'high',
          permissionMode: 'default',
        }),
      })
      expect(createRes.status).toBe(201)
      const { sessionId } = await createRes.json() as { sessionId: string }

      ws = new WebSocket(`${wsBaseUrl}/ws/${sessionId}`)
      await new Promise<void>((resolve, reject) => {
        ws!.onopen = () => resolve()
        ws!.onerror = () => reject(new Error('ws open failed'))
      })
      ws.onmessage = (event) => {
        received.push(JSON.parse(String(event.data)) as ServerMessage)
      }
      const send = (msg: ClientMessage) => ws!.send(JSON.stringify(msg))

      // 1. Mid-turn WS steering: send slow turn, then steer with "怎么样了"
      send({ type: 'user_message', content: 'Deploy release [slow-turn]' })
      await waitUntil(() =>
        conversationService.isAntigravityResponding(sessionId) &&
        received.some(m => m.type === 'content_delta' && m.text.includes('Working...')),
      )

      const completesBeforeSteer = received.filter(m => m.type === 'message_complete').length
      const errorsBeforeSteer = received.filter(m => m.type === 'error').length
      send({ type: 'user_message', content: '怎么样了' })

      await waitUntil(() => received.filter(m => m.type === 'message_complete').length > completesBeforeSteer)
      // Must NOT emit ANTIGRAVITY_TURN_BUSY or premature message_complete
      expect(received.filter(m => m.type === 'error').slice(errorsBeforeSteer)).toHaveLength(0)
      expect(received.filter(m => m.type === 'message_complete')).toHaveLength(completesBeforeSteer + 1)
      expect(received.some(m => m.type === 'user_message_replay' && m.content === '怎么样了')).toBe(true)
      expect(received.some(m => m.type === 'content_delta' && m.text.includes('Steered:怎么样了'))).toBe(true)

      const completeMsg = received.filter(m => m.type === 'message_complete').at(-1) as Extract<ServerMessage, { type: 'message_complete' }>
      expect(completeMsg.usage).toMatchObject({ input_tokens: 250, output_tokens: 60, cache_read_tokens: 80 })

      // Verify wire sent two session/prompt RPCs and transcript preserved visual order
      const wire = await fake.readWire()
      const promptTexts = wire
        .filter(w => w.method === 'session/prompt')
        .map(w => ((w.params?.prompt as Array<{ text?: string }> | undefined)?.[0]?.text ?? ''))
      expect(promptTexts).toEqual(['Deploy release [slow-turn]', '怎么样了'])

      const detailRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
      expect(detailRes.status).toBe(200)
      const detail = await detailRes.json() as { messages?: Array<{ type: string; content: unknown }> }
      const transcriptSummary = (detail.messages ?? []).map(entry => {
        const blocks = Array.isArray(entry.content) ? entry.content : []
        const text = typeof entry.content === 'string'
          ? entry.content
          : blocks.map(b => (typeof b === 'object' && b && 'text' in b ? String((b as { text?: unknown }).text ?? '') : '')).join('')
        return `${entry.type}:${text}`
      })
      expect(transcriptSummary).toEqual([
        'user:Deploy release [slow-turn]',
        'assistant:Working...',
        'user:怎么样了',
        'assistant:Steered:怎么样了',
      ])

      // 2. Mid-turn /compact is rejected with ANTIGRAVITY_TURN_BUSY without cancelling the active turn
      const completesBeforeCompactReject = received.filter(m => m.type === 'message_complete').length
      send({ type: 'user_message', content: 'Keep working [slow-turn]' })
      await waitUntil(() => conversationService.isAntigravityResponding(sessionId))
      const errorsBeforeCompactReject = received.filter(m => m.type === 'error').length
      send({ type: 'user_message', content: '/compact' })
      await waitUntil(() => received.filter(m => m.type === 'error').length > errorsBeforeCompactReject)
      const busyErr = received.filter(m => m.type === 'error').at(-1) as Extract<ServerMessage, { type: 'error' }>
      expect(busyErr.code).toBe('ANTIGRAVITY_TURN_BUSY')
      // Active slow turn still completes naturally afterwards
      await waitUntil(() => received.filter(m => m.type === 'message_complete').length > completesBeforeCompactReject)

      // 3. Steering while a permission prompt is pending returns ANTIGRAVITY_TURN_BUSY and leaves the permission intact
      const permsBefore = received.filter(m => m.type === 'permission_request').length
      const completesBeforePerm = received.filter(m => m.type === 'message_complete').length
      const errorsBeforePerm = received.filter(m => m.type === 'error').length
      send({ type: 'user_message', content: 'Needs edit approval [edit-perm]' })
      await waitUntil(() => received.filter(m => m.type === 'permission_request').length > permsBefore)
      send({ type: 'user_message', content: 'Steer during perm' })
      await waitUntil(() => received.filter(m => m.type === 'error').length > errorsBeforePerm)
      expect((received.filter(m => m.type === 'error').at(-1) as Extract<ServerMessage, { type: 'error' }>).code).toBe('ANTIGRAVITY_TURN_BUSY')
      const permReq = received.filter(m => m.type === 'permission_request').at(-1) as Extract<ServerMessage, { type: 'permission_request' }>
      send({ type: 'permission_response', requestId: permReq.requestId, allowed: true })
      await waitUntil(() => received.filter(m => m.type === 'message_complete').length > completesBeforePerm)
    } finally {
      ws?.close()
      await conversationService.stopAllSessionsAndWait(2_000)
      server.stop(true)
    }

    // 4. Direct unit test: double steering + superseded prompt finishing naturally with usage + cancel after steer
    const resolvers: Array<(value: Record<string, unknown>) => void> = []
    const emitted: Array<Record<string, unknown>> = []
    const appended: Array<Record<string, unknown>> = []
    const unitAcp = {
      sessionId: 'native-steer-unit',
      modelId: 'gemini-4-neon',
      supportsImages: true,
      isOpen: true,
      initialAvailableCommands: [],
      launchedWithBypassPermissions: false,
      permissionMode: 'default' as const,
      drained: Promise.resolve(),
      onMessage: undefined as ((method: string, params: Record<string, unknown>, id?: number | string) => void) | undefined,
      prompt: () => new Promise<Record<string, unknown>>(resolve => { resolvers.push(resolve) }),
      reply: () => true,
      cancel: () => {
        const last = resolvers.at(-1)
        if (last) setTimeout(() => last({ stopReason: 'cancelled' }), 5)
        return true
      },
      end: () => {},
      close: () => {},
    }

    const conv = new AntigravityConversation(
      unitAcp as unknown as ConstructorParameters<typeof AntigravityConversation>[0],
      (msg) => emitted.push(msg),
      async (entries) => { appended.push(...entries) },
    )

    expect(conv.send([{ type: 'text', text: 'First prompt' }], 'u-1')).toBe(true)
    await waitUntil(() => resolvers.length === 1)
    // First steer while prompt 1 is still in flight
    expect(conv.steer([{ type: 'text', text: 'Steer 1' }], 'u-2')).toBe(true)
    await waitUntil(() => resolvers.length === 2)
    // Prompt 1 finished naturally with its own usage just before steer 1 landed
    resolvers[0]!({ stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 10 } })
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(conv.isResponding).toBe(true)
    expect(emitted.filter(m => m.type === 'result')).toHaveLength(0)

    // Second steer while steer 1 is in flight
    expect(conv.steer([{ type: 'text', text: 'Steer 2' }], 'u-3')).toBe(true)
    await waitUntil(() => resolvers.length === 3)
    // Prompt 2 superseded immediately with no usage (matching real agy acp)
    resolvers[1]!({ stopReason: 'end_turn' })
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(conv.isResponding).toBe(true)
    expect(emitted.filter(m => m.type === 'result')).toHaveLength(0)

    // Prompt 3 completes with combined usage -> total = 100+300, 20+50, 10+40
    resolvers[2]!({ stopReason: 'end_turn', usage: { inputTokens: 300, outputTokens: 50, cachedReadTokens: 40 } })
    await conv.pendingTurnCompletion
    expect(conv.isResponding).toBe(false)
    const results = emitted.filter(m => m.type === 'result')
    expect(results).toHaveLength(1)
    expect(results[0]?.usage).toEqual({
      input_tokens: 400,
      output_tokens: 70,
      cache_read_input_tokens: 50,
    })

    // Cancel after steer settles cleanly without dangling timers
    resolvers.length = 0
    expect(conv.send([{ type: 'text', text: 'Run before cancel' }], 'u-4')).toBe(true)
    await waitUntil(() => resolvers.length === 1)
    expect(conv.steer([{ type: 'text', text: 'Steer before cancel' }], 'u-5')).toBe(true)
    await waitUntil(() => resolvers.length === 2)
    resolvers[0]!({ stopReason: 'end_turn' })
    expect(conv.cancel()).toBe(true)
    await conv.pendingTurnCompletion
    expect(conv.isResponding).toBe(false)
  })

  test('retains late available_commands_update arriving after session/new during model setup and caches discovered AGY skills for draft/cold-start slash menus', async () => {
    const fake = await installFakeAgy(sandboxDir, 'late-commands')
    process.env.PATH = `${fake.binDir}:/usr/bin:/bin`
    const workDir = join(sandboxDir, 'work-late-commands')
    await mkdir(join(workDir, '.git'), { recursive: true })
    await mkdir(join(workDir, '.agents', 'skills', 'repo-local-skill'), { recursive: true })
    await writeFile(
      join(workDir, '.agents', 'skills', 'repo-local-skill', 'SKILL.md'),
      '---\ndescription: Repo AGY skill\n---\nBody',
      'utf8',
    )

    // 1. openAntigravityAcp with explicit model triggers set_config_option after session/new.
    // Late available_commands_update during that window must NOT be dropped.
    const acp = await openAntigravityAcp(workDir, { modelId: 'gemini-3.8-flash' })
    try {
      expect(acp.initialAvailableCommands.map(c => c.name)).toEqual([
        'swarm',
        'plan',
        'boost',
        'agy-customizations',
        'skill-vetter',
      ])
    } finally {
      acp.close()
      await acp.proc.exited
    }

    // 2. discoverAntigravity captures global/builtin commands during model effort probing
    // so draft /api/skills/commands?providerId=antigravity-acp exposes both disk & discovered skills.
    const status = await discoverAntigravity()
    expect(status.status).toBe('ready')
    expect(getAntigravityDiscoveredCommands().map(c => c.name)).toContain('agy-customizations')

    const draftSkills = await listAntigravitySkillSlashCommands(workDir)
    expect(draftSkills).toContainEqual({
      name: 'repo-local-skill',
      description: 'Repo AGY skill',
      kind: 'skill',
      source: 'project',
    })
    expect(draftSkills).toContainEqual({
      name: 'agy-customizations',
      description: 'AGY built-in customization guide',
      kind: 'skill',
      source: 'user',
    })
    // Built-in AGY commands stay separate from skill entries
    expect(draftSkills.map(c => c.name)).not.toContain('swarm')

    // 3. Cold-start Antigravity session slash-commands endpoint falls back to AGY skills before ACP starts.
    const server = startServer(0, '127.0.0.1')
    const baseUrl = `http://127.0.0.1:${server.port}`
    try {
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workDir,
          title: 'Cold Start AGY',
          providerId: ANTIGRAVITY_PROVIDER_ID,
          modelId: 'gemini-3.8-pro',
        }),
      })
      expect(createRes.status).toBe(201)
      const { sessionId } = await createRes.json() as { sessionId: string }

      const coldSlashRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/slash-commands`)
      expect(coldSlashRes.status).toBe(200)
      const coldSlashBody = await coldSlashRes.json() as { commands: Array<{ name: string; kind?: string }> }
      expect(coldSlashBody.commands.map(c => c.name)).toContain('repo-local-skill')
      expect(coldSlashBody.commands.map(c => c.name)).toContain('agy-customizations')
    } finally {
      server.stop(true)
    }
  })
  test('streams mid-turn usage and tok/s incrementally from Antigravity transcript.jsonl without double-counting prior turns or turn finish', async () => {
    const appDataDir = join(sandboxDir, 'live-usage-appdata')
    const nativeId = 'native-live-usage-1'
    const logsDir = join(appDataDir, 'brain', nativeId, '.system_generated', 'logs')
    await mkdir(logsDir, { recursive: true })
    const transcriptPath = join(logsDir, 'transcript.jsonl')

    // Pre-existing turn from an earlier/resumed session: MUST be ignored by the new turn's live tailer.
    await writeFile(
      transcriptPath,
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        input_tokens: 9_999,
        cache_read_tokens: 8_888,
        output_tokens: 7_777,
      }) + '\n',
      'utf8',
    )

    let onMessage: ((method: string, params: Record<string, unknown>, id?: number | string) => void) | undefined
    let releaseStep1!: () => void
    let releaseStep2!: () => void
    const step1Ready = new Promise<void>(resolve => { releaseStep1 = resolve })
    const step2Ready = new Promise<void>(resolve => { releaseStep2 = resolve })
    let finishTurn!: (result: Record<string, unknown>) => void
    const turnRelease = new Promise<Record<string, unknown>>(resolve => { finishTurn = resolve })

    const fakeAcp = {
      sessionId: nativeId,
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
        // Step 1: model active ~60ms, then tool call pauses model phase and agy flushes PLANNER_RESPONSE
        await new Promise(resolve => setTimeout(resolve, 60))
        onMessage?.('session/update', {
          sessionId: nativeId,
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspecting...' } },
        })
        onMessage?.('session/update', {
          sessionId: nativeId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call_live_1',
            name: 'run_command',
            status: 'in_progress',
            rawInput: { CommandLine: 'ls' },
            title: 'ls',
          },
        })
        // Simulate partial line write followed by completion newline (mid-write safety)
        const step1Line = JSON.stringify({
          step_index: 5,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          input_tokens: 1_200,
          cache_read_tokens: 3_600,
          output_tokens: 400,
        })
        await appendFile(transcriptPath, step1Line.slice(0, 40), 'utf8')
        await appendFile(transcriptPath, step1Line.slice(40) + '\n', 'utf8')
        releaseStep1()

        // Complete tool 1 and enter Step 2 (~60ms active)
        await new Promise(resolve => setTimeout(resolve, 30))
        onMessage?.('session/update', {
          sessionId: nativeId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call_live_1',
            status: 'completed',
            rawOutput: { output: 'ok' },
          },
        })
        await new Promise(resolve => setTimeout(resolve, 60))
        onMessage?.('session/update', {
          sessionId: nativeId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call_live_2',
            name: 'run_command',
            status: 'in_progress',
            rawInput: { CommandLine: 'pwd' },
            title: 'pwd',
          },
        })
        await appendFile(
          transcriptPath,
          JSON.stringify({
            step_index: 9,
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            input_tokens: 800,
            cache_read_tokens: 4_400,
            output_tokens: 600,
          }) + '\n',
          'utf8',
        )
        releaseStep2()

        const result = await turnRelease
        onMessage?.('session/update', {
          sessionId: nativeId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call_live_2',
            status: 'completed',
            rawOutput: { output: '/tmp' },
          },
        })
        return result
      },
      reply: () => true,
      cancel: () => true,
      end: () => {},
      close: () => {},
    }

    const conv = new AntigravityConversation(
      fakeAcp as unknown as ConstructorParameters<typeof AntigravityConversation>[0],
      () => {},
      async () => {},
      { antigravityAppDataDir: appDataDir },
    )

    expect(conv.send([{ type: 'text', text: 'Investigate' }], 'u-live-1')).toBe(true)

    await step1Ready
    const mid1 = conv.getSessionUsageSnapshot() as Record<string, unknown>
    expect(mid1.totalInputTokens).toBe(1_200)
    expect(mid1.totalCacheReadInputTokens).toBe(3_600)
    expect(mid1.totalOutputTokens).toBe(400)
    expect(mid1.totalAPIDuration as number).toBeGreaterThanOrEqual(45)

    // Repeat poll with no new bytes must stay idempotent
    const mid1Again = conv.getSessionUsageSnapshot() as Record<string, unknown>
    expect(mid1Again.totalOutputTokens).toBe(400)

    await step2Ready
    const mid2 = conv.getSessionUsageSnapshot() as Record<string, unknown>
    expect(mid2.totalInputTokens).toBe(2_000)
    expect(mid2.totalCacheReadInputTokens).toBe(8_000)
    expect(mid2.totalOutputTokens).toBe(1_000)
    expect(mid2.totalAPIDuration as number).toBeGreaterThan(mid1.totalAPIDuration as number)

    // Settle turn with authoritative ACP result (inclusive thoughtTokens proven by totalTokens)
    finishTurn({
      stopReason: 'end_turn',
      usage: {
        inputTokens: 2_100,
        cachedReadTokens: 8_200,
        outputTokens: 1_150,
        thoughtTokens: 700,
        totalTokens: 11_450,
      },
    })
    await conv.pendingTurnCompletion

    const finalSnap = conv.getSessionUsageSnapshot() as Record<string, unknown>
    expect(finalSnap.totalInputTokens).toBe(2_100)
    expect(finalSnap.totalCacheReadInputTokens).toBe(8_200)
    expect(finalSnap.totalOutputTokens).toBe(1_150)
    expect(finalSnap.totalAPIDuration as number).toBeGreaterThanOrEqual(mid2.totalAPIDuration as number)
  })

  test('avoids double-counting thoughtTokens when ACP totalTokens proves outputTokens already includes thinking', async () => {
    const runTurn = async (usage: Record<string, number>) => {
      const emitted: Array<Record<string, unknown>> = []
      const fakeAcp = {
        sessionId: 'native-thought-dedup',
        modelId: 'gemini-4-neon',
        supportsImages: true,
        isOpen: true,
        initialAvailableCommands: [],
        launchedWithBypassPermissions: false,
        permissionMode: 'default' as const,
        drained: Promise.resolve(),
        onMessage: undefined as ((method: string, params: Record<string, unknown>, id?: number | string) => void) | undefined,
        async prompt() {
          return { stopReason: 'end_turn', usage }
        },
        reply: () => true,
        cancel: () => true,
        end: () => {},
        close: () => {},
      }
      const conv = new AntigravityConversation(
        fakeAcp as unknown as ConstructorParameters<typeof AntigravityConversation>[0],
        msg => emitted.push(msg),
        async () => {},
        { antigravityAppDataDir: join(sandboxDir, 'empty-thought-appdata') },
      )
      expect(conv.send([{ type: 'text', text: 'hi' }], 'u-thought')).toBe(true)
      await conv.pendingTurnCompletion
      return emitted.find(m => m.type === 'result') as { usage: { output_tokens: number } }
    }

    // Real agy acp shape: outputTokens (300) already includes thoughtTokens (180); totalTokens = 1000 + 500 + 300 = 1800
    const inclusive = await runTurn({
      inputTokens: 1_000,
      cachedReadTokens: 500,
      outputTokens: 300,
      thoughtTokens: 180,
      totalTokens: 1_800,
    })
    expect(inclusive.usage.output_tokens).toBe(300)

    // Exclusive shape: outputTokens (120) excludes thoughtTokens (180); totalTokens = 1000 + 500 + 120 + 180 = 1800
    const exclusive = await runTurn({
      inputTokens: 1_000,
      cachedReadTokens: 500,
      outputTokens: 120,
      thoughtTokens: 180,
      totalTokens: 1_800,
    })
    expect(exclusive.usage.output_tokens).toBe(300)
  })

  test('stop_generation pauses an Antigravity Swarm by cancelling and shutting down agy acp, then runtime-control resume restarts it via session/resume', async () => {
    const {
      antigravitySwarmTeamName,
      forgetAntigravitySwarmSessionMapping,
      resetAntigravitySwarmControlStateForTests,
    } = await import('../services/antigravitySwarmAdapter.js')
    const fake = await installFakeAgy(sandboxDir, 'ready')
    process.env.PATH = `${fake.binDir}:/usr/bin:/bin`
    const workDir = join(sandboxDir, 'ws-swarm-stop-resume')
    const appDataDir = join(sandboxDir, 'agy-appdata-swarm-stop')
    await mkdir(workDir, { recursive: true })
    const prevAppData = process.env.CC_HAHA_ANTIGRAVITY_APP_DATA_DIR
    process.env.CC_HAHA_ANTIGRAVITY_APP_DATA_DIR = appDataDir

    const server = startServer(0, '127.0.0.1')
    const baseUrl = `http://127.0.0.1:${server.port}`
    const wsBaseUrl = `ws://127.0.0.1:${server.port}`
    const nativeSessionId = 'native-session-1'
    const teamName = antigravitySwarmTeamName(nativeSessionId)

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

      // Turn 1 establishes nativeSessionId = 'native-session-1'
      send({ type: 'user_message', content: 'Start swarm' })
      await waitUntil(() => received.some(m => m.type === 'message_complete'))

      // Seed Antigravity Swarm on disk for native-session-1
      const swarmDir = join(appDataDir, 'brain', nativeSessionId, '.system_generated', 'swarm')
      await mkdir(swarmDir, { recursive: true })
      await writeFile(
        join(swarmDir, 'swarm.json'),
        JSON.stringify({ version: 1, backend: 'local', swarm_id: nativeSessionId, created_at: '2026-11-27T02:00:00Z' }),
        'utf8',
      )
      await writeFile(
        join(swarmDir, 'members.json'),
        JSON.stringify({
          title: 'Stop Resume Swarm',
          members: {
            coordinator: { conversation_id: nativeSessionId, role: 'coordinator', phase: 'RUNNING', wake_mode: 'working', killed: false, model: 'gemini-4-neon' },
            reader: { conversation_id: 'worker-reader-1', role: 'worker', phase: 'RUNNING', wake_mode: 'working', killed: false, model: 'gemini-4-neon' },
            monitor: { conversation_id: 'worker-monitor-1', role: 'worker', phase: 'RUNNING', wake_mode: 'anything', killed: false, model: 'gemini-4-neon' },
          },
        }),
        'utf8',
      )
      await writeFile(
        join(swarmDir, 'board.jsonl'),
        `${JSON.stringify({ seq: 1, agent: 'coordinator', kind: 'brief', time: '2026-11-27 02:00:01', text: '@reader Inspect repo' })}\n`,
        'utf8',
      )

      const wbBefore = await (await fetch(`${baseUrl}/api/teams/session/${encodeURIComponent(sessionId)}/workbench`)).json() as {
        snapshots: Array<{ team: { incarnationId: string; members: Array<{ name?: string; activity?: string }> } }>
      }
      const incarnationId = wbBefore.snapshots[0]!.team.incarnationId
      expect(wbBefore.snapshots[0]!.team.members.find(m => m.name === 'reader')?.activity).toBe('active')

      // Start an active turn and click Stop (stop_generation)
      send({ type: 'user_message', content: 'Run swarm task [slow-turn]' })
      await waitUntil(() => conversationService.isAntigravityResponding(sessionId))
      send({ type: 'stop_generation' })

      // Must cancel AND physically stop the agy acp process so background workers/monitors cannot keep running
      await waitUntil(() => !conversationService.hasSession(sessionId))
      const wireAfterStop = await fake.readWire()
      expect(wireAfterStop.some(w => w.method === 'session/cancel')).toBe(true)

      // Runtime control reports paused, and workbench snapshot projects unfinished workers as stopped
      await waitUntil(async () => {
        const res = await fetch(`${baseUrl}/api/teams/${encodeURIComponent(teamName)}/runtime-control?leadSessionId=${encodeURIComponent(sessionId)}&incarnationId=${encodeURIComponent(incarnationId)}`)
        if (res.status !== 200) return false
        const body = await res.json() as { control: { status: string } | null }
        return body.control?.status === 'paused'
      })
      const pausedControlRes = await fetch(
        `${baseUrl}/api/teams/${encodeURIComponent(teamName)}/runtime-control?leadSessionId=${encodeURIComponent(sessionId)}&incarnationId=${encodeURIComponent(incarnationId)}`,
      )
      const pausedControlBody = await pausedControlRes.json() as {
        control: { status: string; revision: number; resumeEligibleCount: number }
      }
      expect(pausedControlBody.control).toMatchObject({
        status: 'paused',
        resumeEligibleCount: 1,
      })

      const wbPaused = await (await fetch(`${baseUrl}/api/teams/session/${encodeURIComponent(sessionId)}/workbench`)).json() as {
        snapshots: Array<{ team: { members: Array<{ name?: string; activity?: string }> } }>
      }
      expect(wbPaused.snapshots[0]!.team.members.find(m => m.name === 'reader')?.activity).toBe('stopped')
      expect(wbPaused.snapshots[0]!.team.members.find(m => m.name === 'monitor')?.activity).toBe('stopped')

      // Resume via runtime-control API -> restarts agy acp with session/resume and sends coordinator resume prompt
      const resumeRes = await fetch(`${baseUrl}/api/teams/${encodeURIComponent(teamName)}/runtime-control/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadSessionId: sessionId,
          incarnationId,
          expectedRevision: pausedControlBody.control.revision,
          requestId: 'req-e2e-swarm-resume-1',
        }),
      })
      expect(resumeRes.status).toBe(200)
      const resumeBody = await resumeRes.json() as { control: { status: string } }
      expect(resumeBody.control.status).toBe('running')

      // Verify a fresh agy acp process resumed native-session-1 and received the resume prompt naming @reader and @monitor resume
      await waitUntil(() => conversationService.hasSession(sessionId) && !conversationService.isAntigravityResponding(sessionId))
      const wireAfterResume = await fake.readWire()
      expect(wireAfterResume.filter(w => w.method === 'session/resume').at(-1)?.params?.sessionId).toBe(nativeSessionId)
      const lastPrompt = wireAfterResume.filter(w => w.method === 'session/prompt').at(-1)
      const promptBlocks = (lastPrompt?.params?.prompt ?? []) as Array<{ text?: string }>
      const promptText = promptBlocks.map(b => b.text ?? '').join('\n')
      expect(promptText).toContain('@reader')
      expect(promptText).toContain('@monitor resume')

      ws.close()
    } finally {
      server.stop(true)
      forgetAntigravitySwarmSessionMapping(nativeSessionId)
      resetAntigravitySwarmControlStateForTests()
      if (prevAppData === undefined) delete process.env.CC_HAHA_ANTIGRAVITY_APP_DATA_DIR
      else process.env.CC_HAHA_ANTIGRAVITY_APP_DATA_DIR = prevAppData
    }
  }, 20_000)
})

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  throw new Error('Timed out waiting for condition')
}
