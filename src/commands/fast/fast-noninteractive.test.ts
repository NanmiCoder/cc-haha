import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getClientType,
  getIsInteractive,
  setClientType,
  setIsInteractive,
} from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import { resetFastModeStateForTesting } from '../../utils/fastMode.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { call } from './fast-noninteractive.js'

const SAVED_ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_DISABLE_FAST_MODE',
  'CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK',
] as const

function makeContext(initialModel: string, initialFastMode = false) {
  let state = {
    mainLoopModel: initialModel,
    fastMode: initialFastMode,
  } as unknown as AppState

  const context = {
    getAppState: () => state,
    setAppState: (updater: (prev: AppState) => AppState) => {
      state = updater(state)
    },
    options: {
      mainLoopModel: initialModel,
    },
  } as unknown as ToolUseContext

  return {
    context,
    getState: () => state,
  }
}

describe('/fast non-interactive command', () => {
  let tempDir: string
  let savedEnv: Record<string, string | undefined>
  let savedInteractive: boolean
  let savedClientType: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cc-haha-fast-cmd-test-'))
    savedEnv = {}
    for (const key of SAVED_ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    process.env.CLAUDE_CONFIG_DIR = tempDir
    process.env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK = '1'
    savedInteractive = getIsInteractive()
    savedClientType = getClientType()
    setIsInteractive(false)
    setClientType('claude-desktop')
    resetFastModeStateForTesting()
    resetSettingsCache()
  })

  afterEach(() => {
    for (const key of SAVED_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    setIsInteractive(savedInteractive)
    setClientType(savedClientType)
    resetFastModeStateForTesting()
    resetSettingsCache()
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('enables, persists, and disables fastMode on a supported model', async () => {
    const { context, getState } = makeContext('claude-opus-5-5', false)

    const onResult = await call('on', context)
    expect(onResult.value).toContain('Fast mode ON')
    expect(getState().fastMode).toBe(true)
    const persistedOn = JSON.parse(readFileSync(join(tempDir, 'settings.json'), 'utf8'))
    expect(persistedOn.fastMode).toBe(true)

    const toggleOffResult = await call('', context)
    expect(toggleOffResult.value).toBe('Fast mode OFF')
    expect(getState().fastMode).toBe(false)
    const persistedOff = JSON.parse(readFileSync(join(tempDir, 'settings.json'), 'utf8'))
    expect(persistedOff.fastMode).toBeUndefined()
  })

  test('rejects enabling fast mode on an unsupported model without persisting', async () => {
    const { context, getState } = makeContext('claude-sonnet-5-5', false)

    const result = await call('on', context)
    expect(result.value).toContain('not supported on claude-sonnet-5-5')
    expect(getState().fastMode).toBe(false)
  })

  test('returns usage hint for invalid arguments', async () => {
    const { context } = makeContext('claude-opus-5-5', false)
    const result = await call('invalid', context)
    expect(result.value).toBe('Usage: /fast [on|off]')
  })

  test('toggles fast mode OFF via bare /fast on an unsupported model when persisted fastMode is true', async () => {
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify({ fastMode: true }))
    resetSettingsCache()
    const { context, getState } = makeContext('claude-sonnet-5-5', false)

    const result = await call('', context)
    expect(result.value).toBe('Fast mode OFF')
    expect(getState().fastMode).toBe(false)
    const persisted = JSON.parse(readFileSync(join(tempDir, 'settings.json'), 'utf8'))
    expect(persisted.fastMode).toBeUndefined()
  })
})
