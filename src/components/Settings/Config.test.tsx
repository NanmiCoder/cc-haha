import { expect, spyOn, test } from 'bun:test'
import React from 'react'
import { render } from 'ink'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as ink from '../../ink.js'
import * as appState from '../../state/AppState.js'
import * as config from '../../utils/config.js'
import * as settings from '../../utils/settings/settings.js'
import * as memory from '../../utils/claudemd.js'
import * as tabs from '../design-system/Tabs.js'
import * as bindings from '../../keybindings/useKeybinding.js'
import * as search from '../../hooks/useSearchInput.js'
import * as terminal from '../../hooks/useTerminalSize.js'
import * as instructions from '../../utils/instructionFiles.js'
import { Config } from './Config.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 20))

test('list Escape belongs to Config and restores project instructions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'config-cancel-'))
  const oldHome = process.env.HOME
  const oldConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.HOME = dir
  process.env.CLAUDE_CONFIG_DIR = dir
  const spies: Array<{ mockRestore(): void }> = []
  let keyDown: (event: any) => void = () => {}
  const handlers = new Map<string, () => void>()
  let ownsEsc = false
  let closed: string | undefined
  let state = appState.getDefaultAppState()
  const initial = { pluginConfigs: { 'agents-md@builtin': { options: { instructionFiles: 'claude-md-or-agents-md', sibling: true } } } }
  let user = structuredClone(initial)
  const memoryPromise = Promise.resolve([])
  const store = { getState: () => state }
  spies.push(
    spyOn(ink, 'Box').mockImplementation((props: any) => { if (props.onKeyDown) keyDown = props.onKeyDown; return null }),
    spyOn(ink, 'useTheme').mockReturnValue([{}, () => {}] as any),
    spyOn(ink, 'useThemeSetting').mockReturnValue('dark' as any),
    spyOn(ink, 'useTerminalFocus').mockReturnValue(true),
    spyOn(appState, 'useAppState').mockImplementation((selector: any) => selector(state)),
    spyOn(appState, 'useSetAppState').mockReturnValue((updater: any) => { state = updater(state) }),
    spyOn(appState, 'useAppStateStore').mockReturnValue(store as any),
    spyOn(config, 'getGlobalConfig').mockReturnValue({} as any),
    spyOn(config, 'saveGlobalConfig').mockImplementation(() => {}),
    spyOn(config, 'getCurrentProjectConfig').mockReturnValue({} as any),
    spyOn(settings, 'getInitialSettings').mockImplementation(() => user),
    spyOn(settings, 'getSettingsForSource').mockImplementation(source => source === 'userSettings' ? user : {}),
    spyOn(settings, 'updateSettingsForSource').mockImplementation((source, patch) => {
      if (source === 'userSettings' && patch.pluginConfigs) {
        user = { ...user, pluginConfigs: { ...user.pluginConfigs, 'agents-md@builtin': { options: { ...user.pluginConfigs['agents-md@builtin'].options, ...patch.pluginConfigs['agents-md@builtin']?.options } } } } as typeof user
      }
      return { error: null }
    }),
    spyOn(memory, 'getMemoryFiles').mockReturnValue(memoryPromise),
    spyOn(memory, 'clearMemoryFileCaches').mockImplementation(() => {}),
    spyOn(tabs, 'useTabHeaderFocus').mockReturnValue({ headerFocused: false, focusHeader: () => {} } as any),
    spyOn(search, 'useSearchInput').mockReturnValue({ query: 'instructions', setQuery: () => {}, cursorOffset: 12 } as any),
    spyOn(terminal, 'useTerminalSize').mockReturnValue({ rows: 30, columns: 100 } as any),
    spyOn(bindings, 'useKeybinding').mockImplementation((action, handler, options) => {
      if (options?.isActive) handlers.set(action, handler as () => void)
      else handlers.delete(action)
    }),
    spyOn(bindings, 'useKeybindings').mockImplementation((actions, options) => {
      for (const [action, handler] of Object.entries(actions)) {
        if (options?.isActive) handlers.set(action, handler as () => void)
        else handlers.delete(action)
      }
    }),
  )
  const app = render(<React.Suspense fallback={null}><Config context={{ options: { mcpClients: [] } } as any} onClose={value => { closed = value }} setTabsHidden={() => {}} onIsSearchModeChange={value => { ownsEsc = value }} /></React.Suspense>, {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitOnCtrlC: false, patchConsole: false,
  })
  try {
    await new Promise(resolve => setTimeout(resolve, 350))
    keyDown({ key: 'return', preventDefault() {} })
    await tick()
    expect(ownsEsc).toBe(true)
    handlers.get('select:accept')?.()
    await tick()
    expect(instructions.getInstructionFilesModeFromSettings(user)).toBe('claude-md-and-agents-md')
    handlers.get('confirm:no')?.()
    await tick()
    expect(closed).toBe('Config dialog dismissed')
    expect(instructions.getInstructionFilesModeFromSettings(user)).toBe('claude-md-or-agents-md')
    expect(user.pluginConfigs['agents-md@builtin'].options.sibling).toBe(true)
  } finally {
    app.unmount()
    for (const spy of spies.reverse()) spy.mockRestore()
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = oldConfig
    rmSync(dir, { recursive: true, force: true })
  }
})
