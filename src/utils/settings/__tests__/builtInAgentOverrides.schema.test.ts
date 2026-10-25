import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { EFFORT_LEVELS } from '../../effort.js'
import { getSettingsForSource } from '../settings.js'
import { resetSettingsCache } from '../settingsCache.js'
import { SettingsSchema } from '../types.js'

// parseSettingsFileUncached returns `{ settings: null }` for the WHOLE file when
// SettingsSchema rejects it, so a typo in one optional key would silently drop
// the user's permissions, hooks and model. Every case here drives a real file
// through the real reader rather than calling the schema directly, because the
// discard happens in the reader, not in the schema.
describe('builtInAgentOverrides settings schema', () => {
  let tmpDir: string
  let projectRoot: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'built-in-overrides-'))
    projectRoot = path.join(tmpDir, 'project')
    await fs.mkdir(path.join(projectRoot, '.claude'), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // `projectRootOverride` bypasses the per-source cache, but parseSettingsFile
  // keeps its own cache keyed by path — rewriting the same file without
  // clearing it replays the first parse. Production clears it on every write
  // (writeJsonFile -> resetSettingsCache), so do the same here.
  async function readSettings(raw: unknown) {
    await fs.writeFile(
      path.join(projectRoot, '.claude', 'settings.json'),
      typeof raw === 'string' ? raw : JSON.stringify(raw),
    )
    resetSettingsCache()
    return getSettingsForSource('projectSettings', projectRoot)
  }

  it('upgrades model-only fixtures by inheriting the provider without rewriting unknown fields', async () => {
    const legacy = { model: 'opus', builtInAgentOverrides: { Explore: { model: 'sonnet', effort: 'low', futureField: true } } }
    const settings = await readSettings(legacy)
    expect(settings?.builtInAgentOverrides?.Explore).toEqual(legacy.builtInAgentOverrides.Explore)
    expect(settings?.builtInAgentOverrides?.Explore?.providerId).toBeUndefined()
    expect(JSON.parse(await fs.readFile(path.join(projectRoot, '.claude', 'settings.json'), 'utf8'))).toEqual(legacy)
  })

  it('normalizes provider IDs while invalid provider values keep sibling settings', async () => {
    const settings = await readSettings({
      model: 'opus',
      builtInAgentOverrides: {
        Explore: { providerId: '  provider-b  ', model: 'deepseek-flash' },
        Plan: { providerId: 3, effort: 'high' },
        verification: { providerId: '  ', model: 'sonnet' },
      },
    })
    expect(settings?.builtInAgentOverrides?.Explore?.providerId).toBe('provider-b')
    expect(settings?.builtInAgentOverrides?.Plan).toEqual({ providerId: undefined, effort: 'high' })
    expect(settings?.builtInAgentOverrides?.verification?.providerId).toBeUndefined()
    expect(settings?.model).toBe('opus')
  })

  it('parses a well-formed override for both fields', async () => {
    const settings = await readSettings({
      builtInAgentOverrides: {
        Explore: { model: 'sonnet', effort: 'low' },
        'general-purpose': { effort: 'high' },
      },
    })

    expect(settings?.builtInAgentOverrides).toEqual({
      Explore: { model: 'sonnet', effort: 'low' },
      'general-purpose': { effort: 'high' },
    })
  })

  it('keeps the rest of settings.json when the override key is malformed', async () => {
    const settings = await readSettings({
      model: 'opus',
      env: { FOO: '1' },
      builtInAgentOverrides: 'nope',
    })

    // The whole point: a bad value degrades to "no overrides", it does not
    // take the file down with it.
    expect(settings).not.toBeNull()
    expect(settings?.model).toBe('opus')
    expect(settings?.env).toEqual({ FOO: '1' })
    expect(settings?.builtInAgentOverrides).toBeUndefined()
  })

  it('drops only the invalid field, keeping its sibling on the same agent', async () => {
    const settings = await readSettings({
      model: 'opus',
      builtInAgentOverrides: {
        Explore: { model: 'sonnet', effort: 'extreme' },
      },
    })

    expect(settings?.model).toBe('opus')
    expect(settings?.builtInAgentOverrides?.Explore?.model).toBe('sonnet')
    expect(settings?.builtInAgentOverrides?.Explore?.effort).toBeUndefined()
  })

  it('drops only the malformed agent entry, keeping its siblings', async () => {
    const settings = await readSettings({
      builtInAgentOverrides: {
        Explore: 'sonnet',
        Plan: { model: 'opus' },
      },
    })

    expect(settings?.builtInAgentOverrides?.Explore).toEqual({})
    expect(settings?.builtInAgentOverrides?.Plan).toEqual({ model: 'opus' })
  })

  it('accepts an empty-string model as absent rather than rejecting the file', async () => {
    const settings = await readSettings({
      model: 'opus',
      builtInAgentOverrides: { Explore: { model: '   ' } },
    })

    expect(settings?.model).toBe('opus')
    expect(settings?.builtInAgentOverrides?.Explore?.model).toBeUndefined()
  })

  it('reads a settings file written before the key existed', async () => {
    // Old fixture: no builtInAgentOverrides at all. Absent must stay absent —
    // never an empty object — so callers can tell "no overrides" from "{}".
    const settings = await readSettings({
      model: 'opus',
      permissions: { allow: ['Bash(git status)'] },
    })

    expect(settings?.model).toBe('opus')
    expect(settings?.permissions?.allow).toEqual(['Bash(git status)'])
    expect(settings?.builtInAgentOverrides).toBeUndefined()
    expect('builtInAgentOverrides' in (settings ?? {})).toBe(false)
  })

  it('accepts every agent-level effort level, including the ones session effortLevel omits', async () => {
    // Agent-level effort has no `max` gate — the session-level `effortLevel`
    // key does. Reading one from the other would make `xhigh`/`max` writable in
    // Markdown frontmatter but unselectable here.
    for (const effort of EFFORT_LEVELS) {
      const settings = await readSettings({
        builtInAgentOverrides: { Explore: { effort } },
      })
      expect(settings?.builtInAgentOverrides?.Explore?.effort).toBe(effort)
    }

    // Integer efforts stay supported for existing SDK/JSON configs.
    const numeric = await readSettings({
      builtInAgentOverrides: { Explore: { effort: 7 } },
    })
    expect(numeric?.builtInAgentOverrides?.Explore?.effort).toBe(7)
  })

  it('enumerates exactly the runtime effort levels', () => {
    // types.ts inlines the level list to avoid a
    // types -> effort -> settings -> types import cycle. This asserts the copy
    // did not drift from the runtime source.
    const parsed = SettingsSchema().parse({
      builtInAgentOverrides: Object.fromEntries(
        EFFORT_LEVELS.map(level => [level, { effort: level }]),
      ),
    })
    for (const level of EFFORT_LEVELS) {
      expect(parsed.builtInAgentOverrides?.[level]?.effort).toBe(level)
    }
  })
})
