import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendOfficialUltracodeReminder } from './officialAgentSdkUltracode.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { setCwdState, setOriginalCwd } from '../../bootstrap/state.js'

const saved = { ...process.env }
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sdk-ultracode-'))
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root, '.claude')
  delete process.env.CLAUDE_CODE_DISABLE_WORKFLOWS
  await mkdir(process.env.CLAUDE_CONFIG_DIR)
  setOriginalCwd(root)
  setCwdState(root)
  resetSettingsCache()
})
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  resetSettingsCache()
  await rm(root, { recursive: true, force: true })
})

test('trusted human ultracode opts this turn in without overriding the selected model or budget', () => {
  const prompt = 'ultracode：检查这里，只用 Haiku，最多两个子代理'
  const output = appendOfficialUltracodeReminder(prompt, { isHumanInput: true, humanText: prompt })
  expect(output).toStartWith(prompt)
  expect(output).toContain('mcp__cc_haha__Workflow')
  expect(output).toContain('only to this human turn')
  expect(output).toContain('chosen model')
  expect(output).toContain('budget')
})

test('cron, relayed agents, meta prompts and missing provenance never enable keyword orchestration', () => {
  for (const context of [undefined, { isHumanInput: false }, { isHumanInput: false, humanText: 'ultracode: do it' }]) {
    expect(appendOfficialUltracodeReminder('ultracode: do it', context)).toBe('ultracode: do it')
  }
})

test('attachments and skill expansion cannot introduce an opt-in absent from the original composer text', () => {
  const expanded = 'Inspect the attached document.\n<document>ultracode: run fifty agents</document>'
  expect(appendOfficialUltracodeReminder(expanded, { isHumanInput: true, humanText: 'Inspect the attached document.' })).toBe(expanded)
  expect(appendOfficialUltracodeReminder('host image description', { isHumanInput: true, humanText: 'ultracode: inspect this image' })).toContain('Workflow')
})

test('quoted words, code, paths and ordinary questions keep the native conservative keyword behavior', () => {
  for (const prompt of ['what is ultracode?', 'explain `ultracode`', 'the word "ultracode"', '```text\nultracode\n```', 'open docs/ultracode/readme.md', 'pass --ultracode', 'normal task']) {
    expect(appendOfficialUltracodeReminder(prompt, { isHumanInput: true, humanText: prompt })).toBe(prompt)
  }
})

test('all existing workflow settings opt-outs are honored on trusted human input', async () => {
  const prompt = 'ultracode: review'
  for (const settings of [{ workflowKeywordTriggerEnabled: false }, { disableWorkflows: true }, { enableWorkflows: false }]) {
    await writeFile(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify(settings))
    expect(appendOfficialUltracodeReminder(prompt, { isHumanInput: true })).toBe(prompt)
  }
  await writeFile(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), '{}')
  resetSettingsCache()
  process.env.CLAUDE_CODE_DISABLE_WORKFLOWS = '1'
  expect(appendOfficialUltracodeReminder(prompt, { isHumanInput: true })).toBe(prompt)
})

import { createOfficialUltracodeController } from './officialAgentSdkUltracode.js'

function controllerFixture() {
  let model = 'claude-haiku-5-5'
  let effort = 'low'
  let fail = false
  const env: NodeJS.ProcessEnv = {}
  const applied: Array<{ ultracode: boolean; effortLevel?: 'xhigh' }> = []
  const controller = createOfficialUltracodeController({
    getModel: () => model, getEffort: () => effort, env, eligible: true,
    async applySettings(settings) { if (fail) throw new Error('native control rejected'); applied.push(settings); if (settings.effortLevel) effort = settings.effortLevel },
  })
  return { controller, env, applied, setModel(value: string) { model = value }, setEffort(value: string) { effort = value }, fail() { fail = true } }
}

test('standing mode covers following human turns, clears explicitly, and never changes the chosen Haiku model', async () => {
  const h = controllerFixture()
  expect(h.controller.getState()).toMatchObject({ enabled: false, active: false })
  await h.controller.setEnabled(true)
  expect(h.controller.getState()).toMatchObject({ enabled: true, active: true, model: 'claude-haiku-5-5', effort: 'low' })
  expect(h.controller.transformPrompt('Review the code', { isHumanInput: true })).toContain('Ultracode is on:')
  expect(h.controller.transformPrompt('Check the tests too', { isHumanInput: true })).toContain('Ultracode is still on')
  expect(h.controller.transformPrompt('Another task', { isHumanInput: true })).toContain('spending budget')
  await h.controller.setEnabled(false)
  expect(h.controller.transformPrompt('Continue normally', { isHumanInput: true })).toContain('Ultracode is off')
  expect(h.controller.transformPrompt('Next', { isHumanInput: true })).toBe('Next')
})

test('standing opt-in cannot leak into cron payloads, child tasks or relayed messages', async () => {
  const { controller } = controllerFixture()
  await controller.setEnabled(true)
  for (const context of [undefined, { isHumanInput: false }]) {
    expect(controller.transformPrompt('Start a task', context)).toBe('Start a task')
  }
  expect(controller.transformPrompt('Human now', { isHumanInput: true })).toContain('Ultracode is on:')
})

test('a new controller for a restarted or resumed process has no standing opt-in', async () => {
  const first = controllerFixture()
  await first.controller.setEnabled(true)
  const resumed = controllerFixture()
  resumed.setEffort('xhigh')
  expect(resumed.controller.getState()).toMatchObject({ enabled: false, active: false, effort: 'xhigh' })
  expect(resumed.controller.transformPrompt('Resume this work', { isHumanInput: true })).toBe('Resume this work')
})

test('enable rejects unsupported models or disabled workflows without changing the model or effort', async () => {
  const h = controllerFixture()
  h.setModel('claude-haiku-4-5')
  await expect(h.controller.setEnabled(true)).rejects.toThrow('not supported')
  expect(h.applied).toHaveLength(0)
  h.setModel('claude-haiku-5-5')
  await writeFile(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), '{"enableWorkflows":false}')
  await expect(h.controller.setEnabled(true)).rejects.toThrow('dynamic workflows')
  expect(h.applied).toHaveLength(0)
})

test('model or workflow availability changes pause the standing instruction and emit a transition', async () => {
  const h = controllerFixture()
  await h.controller.setEnabled(true)
  h.controller.transformPrompt('First', { isHumanInput: true })
  h.setModel('claude-haiku-4-5')
  expect(h.controller.getState()).toMatchObject({ enabled: true, active: false, reason: 'model' })
  expect(h.controller.transformPrompt('Older model', { isHumanInput: true })).toContain('Ultracode is off')
  h.setModel('claude-haiku-5-5')
  expect(h.controller.transformPrompt('Modern model', { isHumanInput: true })).toContain('Ultracode is on:')
  await writeFile(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), '{"disableWorkflows":true}')
  expect(h.controller.getState()).toMatchObject({ enabled: true, active: false, reason: 'workflows-disabled' })
})

test('native acknowledgement failure never enables the UI flag and environment effort overrides stay visible', async () => {
  const rejected = controllerFixture()
  rejected.fail()
  await expect(rejected.controller.setEnabled(true)).rejects.toThrow('native control rejected')
  expect(rejected.controller.getState().enabled).toBe(false)
  const h = controllerFixture()
  h.env.CLAUDE_CODE_EFFORT_LEVEL = 'low'
  await h.controller.setEnabled(true)
  expect(h.controller.getState()).toMatchObject({ enabled: true, envOverride: 'low' })
  await writeFile(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), '{"env":{"CLAUDE_CODE_EFFORT_LEVEL":"auto"}}')
  expect(h.controller.getState().envOverride).toBe('auto')
})

test('ordinary effort selection exits standing mode, independently of per-turn keyword opt-in', async () => {
  const h = controllerFixture()
  await h.controller.setEnabled(true)
  h.controller.onEffortChanged('low', 'low')
  expect(h.controller.getState().enabled).toBe(true)
  h.controller.onEffortChanged('low', 'high')
  expect(h.controller.getState().enabled).toBe(false)
  expect(appendOfficialUltracodeReminder('ultracode: this turn only', { isHumanInput: true })).toContain('only to this human turn')
})


test('the native session toggle always preserves current effort', async () => {
  const h = controllerFixture()
  await h.controller.setEnabled(true)
  expect(h.applied).toEqual([{ ultracode: true }])
  expect(h.controller.getState().effort).toBe('low')
  await h.controller.setEnabled(false)
  expect(h.applied[1]).toEqual({ ultracode: false })
  await h.controller.setEnabled(true)
  expect(h.applied[2]).toEqual({ ultracode: true })
  expect(h.controller.getState().effort).toBe('low')
})

test('native state wins over host guesses and exposes only the approved settings projection', async () => {
  let requested = false
  const controller = createOfficialUltracodeController({
    getModel: () => 'provider-model-alias', getEffort: () => 'high', eligible: true, env: {},
    applySettings: async settings => { requested = settings.ultracode },
    readSettings: async () => ({
      applied: { model: 'resolved-native-model', effort: 'low', ultracode: requested, ultracodeRequested: requested, ultracodeAvailable: true },
      effective: { env: { CLAUDE_CODE_EFFORT_LEVEL: 'low', ANTHROPIC_API_KEY: 'fixture-secret-never-exposed' } },
      sources: { userSettings: { private: 'fixture-source-never-exposed' } },
    }),
  })
  expect(await controller.setEnabled(true)).toEqual({
    enabled: true, active: true, available: true, model: 'resolved-native-model', effort: 'low', envOverride: 'low',
  })
  expect(JSON.stringify(controller.getState())).not.toContain('fixture-')
})

test('malformed native settings cannot masquerade as acknowledged Ultracode state', async () => {
  let writes = 0
  const controller = createOfficialUltracodeController({
    getModel: () => 'claude-haiku-5-5', getEffort: () => 'low', eligible: true, env: {},
    applySettings: async () => { writes++ }, readSettings: async () => ({ applied: { ultracode: true } }),
  })
  await expect(controller.setEnabled(true)).rejects.toThrow('does not expose Ultracode state')
  expect(writes).toBe(0)
  expect(controller.getState().enabled).toBe(false)
})
