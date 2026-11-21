import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { getSettingsForSource } from '../settings.js'
import { resetSettingsCache } from '../settingsCache.js'
import { SettingsSchema } from '../types.js'

describe('includeCyberRiskInstruction settings schema', () => {
  let tmpDir: string
  let projectRoot: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyber-risk-schema-'))
    projectRoot = path.join(tmpDir, 'project')
    await fs.mkdir(path.join(projectRoot, '.claude'), { recursive: true })
  })

  afterEach(async () => {
    resetSettingsCache()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function readSettings(raw: unknown) {
    await fs.writeFile(
      path.join(projectRoot, '.claude', 'settings.json'),
      typeof raw === 'string' ? raw : JSON.stringify(raw),
    )
    resetSettingsCache()
    return getSettingsForSource('projectSettings', projectRoot)
  }

  it('accepts false', () => {
    expect(
      SettingsSchema().parse({ includeCyberRiskInstruction: false })
        .includeCyberRiskInstruction,
    ).toBe(false)
  })

  it('accepts true', () => {
    expect(
      SettingsSchema().parse({ includeCyberRiskInstruction: true })
        .includeCyberRiskInstruction,
    ).toBe(true)
  })

  it('keeps old settings files without the field valid', () => {
    const parsed = SettingsSchema().parse({ model: 'opus' })
    expect(parsed.model).toBe('opus')
    expect(parsed.includeCyberRiskInstruction).toBeUndefined()
  })

  it('rejects non-boolean values', () => {
    expect(() =>
      SettingsSchema().parse({ includeCyberRiskInstruction: 'nope' }),
    ).toThrow()
    expect(() =>
      SettingsSchema().parse({ includeCyberRiskInstruction: 0 }),
    ).toThrow()
  })

  it('reads the field through the real settings reader', async () => {
    const settings = await readSettings({
      model: 'opus',
      includeCyberRiskInstruction: false,
    })
    expect(settings?.model).toBe('opus')
    expect(settings?.includeCyberRiskInstruction).toBe(false)
  })

  it('reads a settings file written before the field existed', async () => {
    const settings = await readSettings({
      model: 'opus',
      permissions: { allow: ['Bash(git status)'] },
    })
    expect(settings?.model).toBe('opus')
    expect(settings?.includeCyberRiskInstruction).toBeUndefined()
  })
})
