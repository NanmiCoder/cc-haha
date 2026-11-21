import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { getClaudeAIOAuthTokens } from '../../utils/auth.js'
import { resetCyberRiskInstructionSessionLatch } from '../../utils/cyberRiskSettings.js'
import { runWithAgentProviderRoute } from '../../utils/model/providerEnvScope.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { CYBER_RISK_MITIGATION_REMINDER, FileReadTool } from './FileReadTool.js'

function makeToolUseContext(): ToolUseContext {
  return {
    readFileState: new Map(),
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
  } as unknown as ToolUseContext
}

let isolatedConfig: string
let fixtureFile: string
const originalEnv = { ...process.env }

beforeAll(async () => {
  isolatedConfig = await mkdtemp(join(tmpdir(), 'file-read-cyber-risk-'))
  process.env.CLAUDE_CONFIG_DIR = isolatedConfig
  fixtureFile = join(isolatedConfig, 'fixture.txt')
  await writeFile(fixtureFile, 'hello world\n', 'utf8')
})

afterAll(async () => {
  resetSettingsCache()
  resetCyberRiskInstructionSessionLatch()
  getClaudeAIOAuthTokens.cache.clear?.()
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  await rm(isolatedConfig, { recursive: true, force: true })
})

function writeUserSettings(settings: Record<string, unknown> | null, resetLatch = true) {
  if (settings === null) {
    rmSync(join(isolatedConfig, 'settings.json'), { force: true })
  } else {
    writeFileSync(
      join(isolatedConfig, 'settings.json'),
      JSON.stringify(settings),
    )
  }
  resetSettingsCache()
  if (resetLatch) resetCyberRiskInstructionSessionLatch()
}

beforeEach(() => {
  delete process.env.CLAUDE_CODE_DISABLE_CYBER_RISK_INSTRUCTION
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  getClaudeAIOAuthTokens.cache.clear?.()
  writeUserSettings(null)
})

async function readFixtureBlock() {
  const result = await FileReadTool.call(
    { file_path: fixtureFile },
    makeToolUseContext(),
  )
  expect(result.data.type).toBe('text')
  return FileReadTool.mapToolResultToToolResultBlockParam(
    result.data,
    'cyber-risk-fixture',
  )
}

test('text read results include the malware reminder by default', async () => {
  const block = await readFixtureBlock()
  expect(block.content).toContain('hello world')
  expect(block.content).toContain(CYBER_RISK_MITIGATION_REMINDER)
})

test('setting false removes the reminder for third-party providers while keeping file content', async () => {
  process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
  writeUserSettings({ includeCyberRiskInstruction: false })
  const block = await readFixtureBlock()
  expect(block.content).toContain('hello world')
  expect(block.content).not.toContain(CYBER_RISK_MITIGATION_REMINDER)
  expect(block.content).not.toContain('consider whether it would be considered malware')
})

test('setting false still includes the reminder on Claude official OAuth accounts', async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-claude-oauth-token'
  writeUserSettings({ includeCyberRiskInstruction: false })
  const block = await readFixtureBlock()
  expect(block.content).toContain('hello world')
  expect(block.content).toContain(CYBER_RISK_MITIGATION_REMINDER)
})

test('a SubAgent routed to a third-party provider inside a Claude official session omits the reminder', async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-claude-oauth-token'
  writeUserSettings({ includeCyberRiskInstruction: false })

  const mainBlock = await readFixtureBlock()
  expect(mainBlock.content).toContain(CYBER_RISK_MITIGATION_REMINDER)

  const route = {
    providerId: 'deepseek-fixture',
    providerName: 'DeepSeek Fixture',
    model: 'deepseek-chat',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_API_KEY: 'fixture-deepseek-key',
    },
  }
  const subagentBlock = await runWithAgentProviderRoute(route, () => readFixtureBlock())
  expect(subagentBlock.content).toContain('hello world')
  expect(subagentBlock.content).not.toContain(CYBER_RISK_MITIGATION_REMINDER)
})

test('changing settings mid-session does not flip FileReadTool behavior until a new session', async () => {
  process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
  const first = await readFixtureBlock()
  expect(first.content).toContain(CYBER_RISK_MITIGATION_REMINDER)

  writeUserSettings({ includeCyberRiskInstruction: false }, false)
  const stillRunning = await readFixtureBlock()
  expect(stillRunning.content).toContain(CYBER_RISK_MITIGATION_REMINDER)

  resetCyberRiskInstructionSessionLatch()
  const newSession = await readFixtureBlock()
  expect(newSession.content).not.toContain(CYBER_RISK_MITIGATION_REMINDER)
})

test('re-enabling restores the reminder in a new session', async () => {
  process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
  writeUserSettings({ includeCyberRiskInstruction: false })
  await readFixtureBlock()
  writeUserSettings(null)
  const block = await readFixtureBlock()
  expect(block.content).toContain(CYBER_RISK_MITIGATION_REMINDER)
})
