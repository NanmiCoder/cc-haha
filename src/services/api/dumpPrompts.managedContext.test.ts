import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearAllDumpState,
  clearApiRequestCache,
  createDumpPromptsFetch,
  getDumpPromptsPath,
  getLastApiRequests,
} from './dumpPrompts.js'
import {
  markSessionSensitive,
  resetSensitivityPolicyForTests,
} from '../managedContext/sensitivityPolicy.js'

const SECRET = 'fake-host-password-123'
const SESSION_ID = 'sensitive-prompt-dump-session'
let sandbox = ''
let originalFetch: typeof globalThis.fetch
let originalUserType: string | undefined
let originalConfigDir: string | undefined

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'm8-dump-prompts-'))
  originalFetch = globalThis.fetch
  originalUserType = process.env.USER_TYPE
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.USER_TYPE = 'ant'
  process.env.CLAUDE_CONFIG_DIR = sandbox
  clearApiRequestCache()
  clearAllDumpState()
  resetSensitivityPolicyForTests()
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalUserType === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = originalUserType
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  clearApiRequestCache()
  clearAllDumpState()
  resetSensitivityPolicyForTests()
  await rm(sandbox, { recursive: true, force: true }).catch(() => undefined)
})

describe('M8 sensitive prompt dump suppression', () => {
  it('writes neither request nor response dump and keeps the issue cache empty', async () => {
    markSessionSensitive(SESSION_ID)
    globalThis.fetch = (async () => Response.json({ assistantEcho: SECRET })) as typeof globalThis.fetch
    const wrapped = createDumpPromptsFetch(SESSION_ID, { traceSessionId: SESSION_ID })
    const body = JSON.stringify({
      model: 'fake-model',
      messages: [{ role: 'user', content: `private ${SECRET}` }],
    })

    const response = await wrapped('https://api.anthropic.invalid/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    expect(response.ok).toBe(true)
    await response.json()
    await Bun.sleep(25)

    expect(getLastApiRequests()).toEqual([])
    const dumpPath = getDumpPromptsPath(SESSION_ID)
    await expect(access(dumpPath)).rejects.toThrow()
  })
})
