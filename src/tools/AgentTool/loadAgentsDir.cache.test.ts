import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { getCwdState, setCwdState } from '../../bootstrap/state.js'
import { agentsHandler } from '../../cli/handlers/agents.js'
import { saveAgentToFile } from '../../components/agents/agentFileUtils.js'
import {
  clearAgentDefinitionsCache,
  getAgentDefinitionsWithOverrides,
} from './loadAgentsDir.js'

let tmpHome: string
let originalHome: string | undefined
let originalUserProfile: string | undefined
let originalClaudeConfigDir: string | undefined
let originalCwdState: string

describe('agent definition cache invalidation', () => {
  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-def-cache-'))
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalCwdState = getCwdState()

    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome
    process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude')
    clearAgentDefinitionsCache()
  })

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }

    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE
    } else {
      process.env.USERPROFILE = originalUserProfile
    }

    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
    }

    setCwdState(originalCwdState)
    clearAgentDefinitionsCache()
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  test('shows a newly-created project agent in the /agents output after an initial cached read', async () => {
    const projectRoot = path.join(tmpHome, 'project')
    await fs.mkdir(projectRoot, { recursive: true })
    setCwdState(projectRoot)

    const agentType = 'cache-created-agent'
    const before = await getAgentDefinitionsWithOverrides(projectRoot)

    expect(before.allAgents.some(agent => agent.agentType === agentType)).toBe(false)

    await saveAgentToFile(
      'projectSettings',
      agentType,
      'Use this agent to verify cache invalidation.',
      undefined,
      'You verify cache invalidation.',
      true,
    )

    const after = await getAgentDefinitionsWithOverrides(projectRoot)

    expect(after.allAgents).toContainEqual(
      expect.objectContaining({
        agentType,
        source: 'projectSettings',
      }),
    )

    const logs: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    }
    try {
      await agentsHandler()
    } finally {
      console.log = originalLog
    }

    expect(logs.join('\n')).toContain(agentType)
  })
})
