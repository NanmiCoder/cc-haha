import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getInstructionFilesModeFromSettings,
  INSTRUCTION_FILE_MODES,
  instructionFilesSettingsPatch,
} from '../../instructionFiles.js'
import { parseSettingsFile, updateSettingsForSource } from '../settings.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function readFixture(value: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'instruction-files-'))
  directories.push(dir)
  await mkdir(join(dir, '.claude'))
  const path = join(dir, '.claude', 'settings.json')
  await writeFile(path, JSON.stringify(value))
  return { settings: parseSettingsFile(path).settings, path, projectRoot: dir }
}

describe('project instruction settings compatibility', () => {
  it('migrates an old settings file at read time without modifying user fields', async () => {
    const fixture = { model: 'sonnet', customFutureField: { retained: true } }
    const { settings, path } = await readFixture(fixture)
    expect(getInstructionFilesModeFromSettings(settings)).toBe('claude-md-or-agents-md')
    expect(settings).toMatchObject(fixture)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(fixture)
  })

  for (const mode of INSTRUCTION_FILE_MODES) {
    it(`reads official builtin plugin option ${mode}`, async () => {
      const { settings } = await readFixture(instructionFilesSettingsPatch(mode))
      expect(getInstructionFilesModeFromSettings(settings)).toBe(mode)
    })
  }

  for (const [legacy, expected] of [
    ['none', 'managed-only'], ['claude', 'claude-md'],
    ['agents-fallback', 'claude-md-or-agents-md'], ['both', 'claude-md-and-agents-md'],
  ]) {
    it(`migrates legacy projectInstructions ${legacy}`, async () => {
      const { settings } = await readFixture({ pluginConfigs: { 'agents-md@builtin': { options: { projectInstructions: legacy } } }, customFutureField: true })
      expect(getInstructionFilesModeFromSettings(settings)).toBe(expected)
      expect(settings?.customFutureField).toBe(true)
    })
  }

  it('writes and cancels one option while retaining sibling plugin settings', async () => {
    const fixture = {
      customFutureField: 'retained',
      pluginConfigs: {
        'agents-md@builtin': { options: { sibling: true } },
        'other@plugin': { options: { option: 'preserved' } },
      },
    }
    const { path, projectRoot } = await readFixture(fixture)
    expect(updateSettingsForSource('projectSettings', instructionFilesSettingsPatch('claude-md'), projectRoot).error).toBeNull()
    expect(parseSettingsFile(path).settings?.pluginConfigs?.['agents-md@builtin']?.options).toEqual({ sibling: true, instructionFiles: 'claude-md' })
    expect(updateSettingsForSource('projectSettings', instructionFilesSettingsPatch(undefined), projectRoot).error).toBeNull()
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject(fixture)
    expect(parseSettingsFile(path).settings?.pluginConfigs?.['agents-md@builtin']?.options?.instructionFiles).toBeUndefined()
  })

  it('clears legacy options on selection and restores them on cancellation', async () => {
    const fixture = { pluginConfigs: { 'agents-md@builtin': { options: { projectInstructions: 'both', sibling: true } } } }
    const { path, projectRoot } = await readFixture(fixture)
    expect(updateSettingsForSource('projectSettings', instructionFilesSettingsPatch('claude-md-or-agents-md'), projectRoot).error).toBeNull()
    expect(getInstructionFilesModeFromSettings(parseSettingsFile(path).settings)).toBe('claude-md-or-agents-md')
    expect(updateSettingsForSource('projectSettings', instructionFilesSettingsPatch(undefined, 'both'), projectRoot).error).toBeNull()
    expect(getInstructionFilesModeFromSettings(parseSettingsFile(path).settings)).toBe('claude-md-and-agents-md')
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject(fixture)
  })

  it('migrates legacy options after independently merging source precedence', () => {
    expect(getInstructionFilesModeFromSettings(
      instructionFilesSettingsPatch('claude-md-or-agents-md'),
      { pluginConfigs: { 'agents-md@builtin': { options: { projectInstructions: 'both' } } } },
    )).toBe('claude-md-and-agents-md')
    expect(getInstructionFilesModeFromSettings(instructionFilesSettingsPatch('unknown', 'unknown'))).toBe('claude-md')
    expect(getInstructionFilesModeFromSettings(instructionFilesSettingsPatch('both'))).toBe('claude-md-or-agents-md')
    expect(getInstructionFilesModeFromSettings({ projectInstructions: 'none' })).toBe('claude-md-or-agents-md')
  })

  it('inherits absent options and honors descending source precedence', () => {
    expect(getInstructionFilesModeFromSettings({}, instructionFilesSettingsPatch('claude-md'))).toBe('claude-md')
    expect(getInstructionFilesModeFromSettings(
      instructionFilesSettingsPatch('managed-only'), instructionFilesSettingsPatch('claude-md'),
    )).toBe('managed-only')
    expect(getInstructionFilesModeFromSettings({
      ...instructionFilesSettingsPatch('claude-md', 'both'),
    })).toBe('claude-md')
  })
})
