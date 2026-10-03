import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { UUID } from 'crypto'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { switchSession } from '../../bootstrap/state.js'
import * as queryModule from '../../query.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import { asAgentId, type SessionId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import {
  createAssistantMessage,
  createUserMessage,
} from '../../utils/messages.js'
import {
  flushSessionStorage,
  getAgentTranscript,
  getAgentTranscriptPath,
  readAgentMetadata,
  resetProjectForTesting,
} from '../../utils/sessionStorage.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { runAgent } from './runAgent.js'

const AGENT_ID = asAgentId('aworker-00112233445566aa')
const savedEnv = {
  configDir: process.env.CLAUDE_CONFIG_DIR,
  persistence: process.env.TEST_ENABLE_SESSION_PERSISTENCE,
  userType: process.env.USER_TYPE,
}
let configDir: string

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'cc-haha-agent-transcript-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  process.env.USER_TYPE = 'external'
  switchSession('7a1c4c5e-1d2b-4f3a-9b8c-0d1e2f3a4b5c' as SessionId)
  resetProjectForTesting()
})

afterEach(async () => {
  mock.restore()
  resetProjectForTesting()
  restoreEnv('CLAUDE_CONFIG_DIR', savedEnv.configDir)
  restoreEnv('TEST_ENABLE_SESSION_PERSISTENCE', savedEnv.persistence)
  restoreEnv('USER_TYPE', savedEnv.userType)
  await rm(configDir, { recursive: true, force: true })
})

function parentContext(): ToolUseContext {
  const agentDefinition = {
    agentType: 'worker',
    whenToUse: 'Teammate',
    rawSystemPrompt: 'Work.',
    getSystemPrompt: () => 'Work.',
    source: 'projectSettings',
  } as const
  const state = getDefaultAppState()
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'sonnet',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' as const },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: {
        activeAgents: [agentDefinition],
        allAgents: [agentDefinition],
      },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(),
    getAppState: () => state,
    setAppState: () => {},
    setResponseLength: () => {},
    messages: [],
  } as unknown as ToolUseContext
}

async function runTurn(params: {
  prompt: Message
  context?: Message[]
  answer: Message
  recordedUuids: Set<UUID>
}): Promise<Message[]> {
  spyOn(queryModule, 'query').mockImplementation(async function* () {
    yield params.answer
  } as never)
  const yielded: Message[] = []
  for await (const message of runAgent({
    agentDefinition: {
      agentType: 'worker',
      whenToUse: 'Teammate',
      getSystemPrompt: () => 'Work.',
      source: 'projectSettings',
    } as never,
    promptMessages: [params.prompt],
    toolUseContext: parentContext(),
    canUseTool: (async () => ({ behavior: 'allow' })) as never,
    isAsync: true,
    forkContextMessages: params.context,
    querySource: 'agent:custom',
    override: {
      userContext: {},
      systemContext: {},
      systemPrompt: asSystemPrompt([]),
      agentId: AGENT_ID,
    },
    availableTools: [],
    recordedUuids: params.recordedUuids,
    extraMetadata: {
      taskKind: 'in_process_teammate',
      teamName: 'team',
      name: 'worker',
      color: 'blue',
      planModeRequired: false,
      permissionMode: 'default',
    },
  })) {
    yielded.push(message)
  }
  return yielded
}

describe('a teammate transcript kept across runs', () => {
  test('appends each turn once and keeps one parent chain', async () => {
    const recordedUuids = new Set<UUID>()
    const firstPrompt = createUserMessage({ content: 'Investigate the failing build' })
    const firstAnswer = createAssistantMessage({ content: 'The lockfile is stale.' })
    await runTurn({ prompt: firstPrompt, answer: firstAnswer, recordedUuids })

    const secondPrompt = createUserMessage({ content: 'Regenerate it' })
    const secondAnswer = createAssistantMessage({ content: 'Regenerated.' })
    await runTurn({
      prompt: secondPrompt,
      // The in-process runner passes the whole conversation back every turn
      context: [firstPrompt, firstAnswer],
      answer: secondAnswer,
      recordedUuids,
    })
    await flushSessionStorage()

    const lines = (await readFile(getAgentTranscriptPath(AGENT_ID), 'utf-8'))
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as { uuid?: string })
    const conversation = [firstPrompt, firstAnswer, secondPrompt, secondAnswer]
    for (const message of conversation) {
      expect(lines.filter(line => line.uuid === message.uuid)).toHaveLength(1)
    }
    expect(
      (await getAgentTranscript(AGENT_ID))?.messages.map(message => message.uuid),
    ).toEqual(conversation.map(message => message.uuid))
    expect([...recordedUuids].sort()).toEqual(
      conversation.map(message => message.uuid).sort(),
    )
  })

  test('records the team identity in the metadata sidecar', async () => {
    await runTurn({
      prompt: createUserMessage({ content: 'Start' }),
      answer: createAssistantMessage({ content: 'Started.' }),
      recordedUuids: new Set(),
    })

    expect(await readAgentMetadata(AGENT_ID)).toEqual({
      agentType: 'worker',
      taskKind: 'in_process_teammate',
      teamName: 'team',
      name: 'worker',
      color: 'blue',
      planModeRequired: false,
      permissionMode: 'default',
    })
  })
})
