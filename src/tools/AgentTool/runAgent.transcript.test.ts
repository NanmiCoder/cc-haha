import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { UUID } from 'crypto'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../../bootstrap/state.js'
import * as queryModule from '../../query.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import { asAgentId, type SessionId } from '../../types/ids.js'
import { getAgentProfile, setAgentProfile } from '../../utils/agentProfile.js'
import type { Message } from '../../types/message.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import {
  createAssistantMessage,
  createUserMessage,
} from '../../utils/messages.js'
import * as sessionStorage from '../../utils/sessionStorage.js'
import {
  flushSessionStorage,
  getAgentTranscript,
  getAgentTranscriptPath,
  readAgentMetadata,
  resetProjectForTesting,
} from '../../utils/sessionStorage.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { runAgent } from './runAgent.js'
import * as agentRunner from './runAgent.js'
import * as agentToolUtils from './agentToolUtils.js'
import * as localAgentTask from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { resumeAgentBackground } from './resumeAgent.js'

const AGENT_ID = asAgentId('aworker-00112233445566aa')
const originalProfile = getAgentProfile()
const writeAgentMetadata = sessionStorage.writeAgentMetadata
const savedEnv = {
  configDir: process.env.CLAUDE_CONFIG_DIR,
  persistence: process.env.TEST_ENABLE_SESSION_PERSISTENCE,
  userType: process.env.USER_TYPE,
}
let configDir: string
let metadataWrites: Promise<void>[] = []
let previousSession: { id: SessionId; projectDir: string | null }

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(async () => {
  previousSession = { id: getSessionId(), projectDir: getSessionProjectDir() }
  metadataWrites = []
  configDir = await mkdtemp(join(tmpdir(), 'cc-haha-agent-transcript-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  process.env.USER_TYPE = 'external'
  // The cwd-based project directory cache outlives each temporary config dir.
  switchSession(
    '7a1c4c5e-1d2b-4f3a-9b8c-0d1e2f3a4b5c' as SessionId,
    join(configDir, 'project'),
  )
  expect(getAgentTranscriptPath(AGENT_ID)).toStartWith(configDir + sep)
  resetProjectForTesting()
  spyOn(sessionStorage, 'writeAgentMetadata').mockImplementation((...args) => {
    const write = writeAgentMetadata(...args)
    metadataWrites.push(write)
    return write
  })
})

afterEach(async () => {
  try {
    // Sidecars bypass the transcript queue. Drain both before changing paths,
    // including when one writer rejects while another is still pending.
    const writes = await Promise.allSettled([
      ...metadataWrites,
      flushSessionStorage(),
    ])
    for (const write of writes) {
      if (write.status === 'rejected') throw write.reason
    }
  } finally {
    mock.restore()
    setAgentProfile(originalProfile)
    resetProjectForTesting()
    restoreEnv('CLAUDE_CONFIG_DIR', savedEnv.configDir)
    restoreEnv('TEST_ENABLE_SESSION_PERSISTENCE', savedEnv.persistence)
    restoreEnv('USER_TYPE', savedEnv.userType)
    switchSession(previousSession.id, previousSession.projectDir)
    await rm(configDir, { recursive: true, force: true })
  }
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
  test('immediately resumes a completed lean subagent while its transcript is still buffered', async () => {
    setAgentProfile('lean')
    const initial = createUserMessage({ content: 'Inspect the parser.' })
    const answer = createAssistantMessage({ content: 'The parser accepts empty arrays.' })
    // Recording resolves after enqueueing; the normal disk drain runs later.
    await sessionStorage.recordSidechainTranscript([initial, answer], AGENT_ID)
    await sessionStorage.writeAgentMetadata(AGENT_ID, { agentType: 'general-purpose' })
    spyOn(localAgentTask, 'registerAsyncAgent').mockReturnValue({ agentId: AGENT_ID, abortController: new AbortController() } as never)
    let lifecycle: Parameters<typeof agentToolUtils.runAsyncAgentLifecycle>[0] | undefined
    spyOn(agentToolUtils, 'runAsyncAgentLifecycle').mockImplementation(async params => { lifecycle = params })
    const runner = spyOn(agentRunner, 'runAgent').mockImplementation(async function* () {})

    const result = await resumeAgentBackground({
      agentId: AGENT_ID, prompt: 'Check the related tests.',
      toolUseContext: parentContext(), canUseTool: (async () => ({ behavior: 'allow' })) as never,
    })
    expect(result.agentId).toBe(AGENT_ID)
    lifecycle?.makeStream(undefined)
    const messages = runner.mock.calls[0]?.[0].promptMessages
    expect(messages?.map(message => message.uuid).slice(0, 2)).toEqual([initial.uuid, answer.uuid])
    expect(JSON.stringify(messages?.at(-1))).toContain('Check the related tests.')
  })

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
    // runAgent starts this write without awaiting it; transcript flushes do
    // not include metadata sidecars.
    await Promise.all(metadataWrites)

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
