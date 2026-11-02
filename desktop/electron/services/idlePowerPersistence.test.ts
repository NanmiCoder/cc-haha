// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readIdlePowerPreferences, writeIdlePowerPreferences } from './idlePowerPersistence'
import { DEFAULT_IDLE_POWER_SETTINGS } from '../../src/lib/idlePower'

const homes: string[] = []
function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'idle-power-persistence-'))
  homes.push(home)
  return { getPath: (_name: 'userData') => home, file: path.join(home, 'idle-power.json') }
}
afterEach(() => { homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })) })

describe('idle power preference migration', () => {
  it('upgrades an existing install with no power configuration to disabled without touching other settings', () => {
    const app = fixture()
    const other = path.join(app.getPath('userData'), 'locale-preference.json')
    writeFileSync(other, '{"locale":"jp"}')
    expect(readIdlePowerPreferences(app)).toMatchObject({ schemaVersion: 1, settings: DEFAULT_IDLE_POWER_SETTINGS, lastAction: null })
    expect(readFileSync(other, 'utf8')).toBe('{"locale":"jp"}')
  })
  it('migrates a frozen unversioned record, preserves extensions, and round trips the last request without replay', () => {
    const app = fixture()
    writeFileSync(app.file, readFileSync(new URL('./fixtures/idle-power-v0.json', import.meta.url), 'utf8'))
    const old = readIdlePowerPreferences(app)
    expect(old).toMatchObject({ schemaVersion: 1, settings: DEFAULT_IDLE_POWER_SETTINGS, lastAction: null, extension: { keep: true } })
    const value = { settings: { ...DEFAULT_IDLE_POWER_SETTINGS, action: 'shutdown' as const }, lastAction: { action: 'shutdown' as const, requestedAt: 1234, result: 'requested' as const } }
    writeIdlePowerPreferences(app, value)
    expect(readIdlePowerPreferences(app)).toMatchObject(value)
    expect(JSON.parse(readFileSync(app.file, 'utf8'))).toMatchObject({ schemaVersion: 1, extension: { keep: true } })
  })
  it('fails closed on corrupt/future data and refuses to overwrite it', () => {
    const app = fixture()
    for (const raw of ['{broken', '{"schemaVersion":9000,"settings":{"action":"shutdown","scope":"any","countdownSeconds":0}}']) {
      writeFileSync(app.file, raw)
      expect(() => readIdlePowerPreferences(app)).toThrow()
      expect(() => writeIdlePowerPreferences(app, { settings: DEFAULT_IDLE_POWER_SETTINGS, lastAction: null })).toThrow()
      expect(readFileSync(app.file, 'utf8')).toBe(raw)
    }
  })
})
