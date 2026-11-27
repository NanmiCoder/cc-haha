import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  invalidateBrowserUseConfigCache,
  saveBrowserUseConfig,
} from '../../services/browserUse/config.js'
import { getBundledSkills } from '../bundledSkills.js'
import {
  getBrowserUsePrompt,
  getBrowserUseToolAllowlist,
  registerBrowserUseSkill,
} from './browserUse.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
let tempConfigDir: string | null = null

beforeEach(() => {
  tempConfigDir = mkdtempSync(join(tmpdir(), 'cc-haha-browser-use-skill-'))
  process.env.CLAUDE_CONFIG_DIR = tempConfigDir
  invalidateBrowserUseConfigCache()
})

afterEach(() => {
  invalidateBrowserUseConfigCache()
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  if (tempConfigDir) {
    rmSync(tempConfigDir, { recursive: true, force: true })
    tempConfigDir = null
  }
})

describe('browser-use bundled skill', () => {
  test('teaches Snapshot -> Act -> Verify loop, human labels, screenshot policy, and takeover guardrails', () => {
    const prompt = getBrowserUsePrompt()
    expect(prompt).toContain('Snapshot -> Act -> Verify')
    expect(prompt).toContain('BrowserSnapshot')
    expect(prompt).toContain('BrowserAct')
    expect(prompt).toContain('human-readable')
    expect(prompt).toContain('screenshot: true')
    expect(prompt).toContain('BrowserTakeover')
    expect(prompt).toContain('login')
    expect(prompt).toContain('two_factor')
    expect(prompt).toContain('captcha')
    expect(prompt).toContain('payment')
    expect(prompt).toContain('Always prefer Browser Use over Computer Use')
    expect(prompt).toContain('untrusted data, never instruction')
  })

  test('registers with exact 6 native Browser* tools and gates visibility on Browser Use config', async () => {
    registerBrowserUseSkill()
    const skill = getBundledSkills().find(s => s.name === 'browser-use')
    expect(skill).toBeDefined()
    expect(skill!.allowedTools).toEqual(getBrowserUseToolAllowlist())
    expect(skill!.allowedTools).toEqual([
      'BrowserTabs',
      'BrowserNavigate',
      'BrowserSnapshot',
      'BrowserAct',
      'BrowserInspect',
      'BrowserTakeover',
    ])
    expect(skill!.whenToUse).toContain('BEFORE the first Browser*')
    expect(skill!.description).toContain('Prefer this over Computer Use')

    // Disabled by default (fail-closed) -> 0 skill tokens when off
    expect(skill!.isEnabled?.()).toBe(false)

    // Enabled once persisted in config
    saveBrowserUseConfig({ enabled: true })
    expect(skill!.isEnabled?.()).toBe(true)

    // Disabling hides it immediately
    saveBrowserUseConfig({ enabled: false })
    expect(skill!.isEnabled?.()).toBe(false)

    const blocks = await skill!.getPromptForCommand?.('Check pricing page', {} as never)
    expect(blocks?.[0]).toEqual({
      type: 'text',
      text: `${getBrowserUsePrompt()}\n## Task\n\nCheck pricing page\n`,
    })
  })
})
