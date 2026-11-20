import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
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
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalEnvValue = process.env.CLAUDE_CODE_DISABLE_CYBER_RISK_INSTRUCTION

beforeAll(async () => {
  isolatedConfig = await mkdtemp(join(tmpdir(), 'file-read-cyber-risk-'))
  process.env.CLAUDE_CONFIG_DIR = isolatedConfig
  fixtureFile = join(isolatedConfig, 'fixture.txt')
  await writeFile(fixtureFile, 'hello world\n', 'utf8')
})

afterAll(async () => {
  resetSettingsCache()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalEnvValue === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_CYBER_RISK_INSTRUCTION
  } else {
    process.env.CLAUDE_CODE_DISABLE_CYBER_RISK_INSTRUCTION = originalEnvValue
  }
  await rm(isolatedConfig, { recursive: true, force: true })
})

function writeUserSettings(settings: Record<string, unknown> | null) {
  if (settings === null) {
    rmSync(join(isolatedConfig, 'settings.json'), { force: true })
  } else {
    writeFileSync(
      join(isolatedConfig, 'settings.json'),
      JSON.stringify(settings),
    )
  }
  resetSettingsCache()
}

beforeEach(() => {
  delete process.env.CLAUDE_CODE_DISABLE_CYBER_RISK_INSTRUCTION
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

test('setting false removes the reminder but keeps the file content', async () => {
  writeUserSettings({ includeCyberRiskInstruction: false })
  const block = await readFixtureBlock()
  expect(block.content).toContain('hello world')
  expect(block.content).not.toContain(CYBER_RISK_MITIGATION_REMINDER)
  expect(block.content).not.toContain('consider whether it would be considered malware')
})

test('re-enabling restores the reminder', async () => {
  writeUserSettings({ includeCyberRiskInstruction: false })
  await readFixtureBlock()
  writeUserSettings(null)
  const block = await readFixtureBlock()
  expect(block.content).toContain(CYBER_RISK_MITIGATION_REMINDER)
})
