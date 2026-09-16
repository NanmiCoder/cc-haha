import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  invalidateComputerUseSkillGate,
  isComputerUseSkillEnabled,
} from './skillGate.js'
import { resolveStoredComputerUseConfig } from './preauthorizedConfig.js'

/**
 * This gate decides whether desktop-control instructions exist in a user's
 * session at all. It is the reason the guidance is a skill rather than MCP
 * server instructions: server instructions ride in the system prompt for as
 * long as the server is connected, which would put them in front of users who
 * deliberately turned the feature off.
 */
beforeEach(() => invalidateComputerUseSkillGate())
afterEach(() => invalidateComputerUseSkillGate())

const configWith = (enabled: boolean) => () => JSON.stringify({ enabled })

describe('computer use skill gate', () => {
  test('follows the user setting', () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return
    expect(isComputerUseSkillEnabled(1, configWith(true))).toBe(true)
    invalidateComputerUseSkillGate()
    expect(isComputerUseSkillEnabled(1, configWith(false))).toBe(false)
  })

  test('follows the app-wide default when the config cannot be read', () => {
    // Must match DEFAULT_COMPUTER_USE_ENABLED, because the Computer Use TOOLS
    // are registered on that same default. Hiding the skill here would produce
    // the one combination that cannot work — tools present, the workflow they
    // assume absent — for every user who has never opened the Settings page.
    if (process.platform !== 'darwin' && process.platform !== 'win32') return
    const appDefault = resolveStoredComputerUseConfig().enabled

    invalidateComputerUseSkillGate()
    expect(
      isComputerUseSkillEnabled(1, () => {
        throw new Error('ENOENT')
      }),
    ).toBe(appDefault)

    invalidateComputerUseSkillGate()
    expect(isComputerUseSkillEnabled(1, () => 'not json at all')).toBe(appDefault)
  })

  test('an explicit off in the config still wins over the default', () => {
    // The whole point of the gate: a user who switched it off must not see it.
    if (process.platform !== 'darwin' && process.platform !== 'win32') return
    invalidateComputerUseSkillGate()
    expect(isComputerUseSkillEnabled(1, configWith(false))).toBe(false)
  })

  test('stays off on platforms without either engine', () => {
    if (process.platform === 'darwin' || process.platform === 'win32') return
    expect(isComputerUseSkillEnabled(1, configWith(true))).toBe(false)
  })

  test('caches briefly so an open slash menu does not stat on every keystroke', () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return
    invalidateComputerUseSkillGate()
    let reads = 0
    const counting = () => {
      reads += 1
      return JSON.stringify({ enabled: true })
    }
    expect(isComputerUseSkillEnabled(1_000, counting)).toBe(true)
    expect(isComputerUseSkillEnabled(1_500, counting)).toBe(true)
    expect(reads).toBe(1)
  })

  test('re-reads after the cache window, so a settings change lands without a restart', () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return
    invalidateComputerUseSkillGate()
    expect(isComputerUseSkillEnabled(1_000, configWith(true))).toBe(true)
    // Far enough past the TTL that the next call must go back to disk.
    expect(isComputerUseSkillEnabled(60_000, configWith(false))).toBe(false)
  })

  test('explicit invalidation takes effect immediately', () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return
    invalidateComputerUseSkillGate()
    expect(isComputerUseSkillEnabled(1, configWith(true))).toBe(true)
    invalidateComputerUseSkillGate()
    expect(isComputerUseSkillEnabled(1, configWith(false))).toBe(false)
  })
})
